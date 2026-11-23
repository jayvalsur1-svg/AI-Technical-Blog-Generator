from __future__ import annotations
import asyncio
import operator
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal, Optional, TypedDict
from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from langgraph.graph import StateGraph, START, END
from langgraph.types import Send
from langchain_core.messages import SystemMessage, HumanMessage

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
OUTPUT_DIR = BASE_DIR / "outputs"
OUTPUT_DIR.mkdir(exist_ok=True)

PROVIDER = os.getenv("LLM_PROVIDER", "groq").lower()
MAX_WORKERS = max(1, min(int(os.getenv("MAX_WORKERS", "2")), 4))
MAX_RESEARCH_QUERIES = max(1, min(int(os.getenv("MAX_RESEARCH_QUERIES", "3")), 5))
ENABLE_RESEARCH = os.getenv("ENABLE_RESEARCH", "true").lower() == "true"

import os

def create_llm(provider=None):

    provider = (
        provider or os.getenv("LLM_PROVIDER", "groq")
    ).lower()

    if provider == "gemini":
        from langchain_google_genai import ChatGoogleGenerativeAI

        return ChatGoogleGenerativeAI(
            model=os.getenv(
                "GEMINI_MODEL",
                "gemini-2.5-flash"
            ),
            temperature=0.3,
            max_retries=1,
        )

    elif provider == "groq":
        from langchain_groq import ChatGroq

        return ChatGroq(
            model=os.getenv(
                "GROQ_MODEL",
                "openai/gpt-oss-20b"
            ),
            temperature=0.3,
            max_tokens=int(os.getenv("MAX_TOKENS", "4096")),
            max_retries=1,
        )

    raise ValueError(f"Unsupported provider: {provider}")


llm = create_llm()
def build_tavily():
    key = os.getenv("TAVILY_API_KEY")
    if not key or not ENABLE_RESEARCH:
        return None
    from tavily import TavilyClient
    return TavilyClient(api_key=key)

tavily_client = build_tavily()

class Task(BaseModel):
    id: int
    title: str
    goal: str
    bullets: list[str] = Field(min_length=3, max_length=6)
    target_words: int = Field(ge=120, le=550)
    tags: list[str] = Field(default_factory=list)
    requires_research: bool = False
    requires_citations: bool = False
    requires_code: bool = False

class Plan(BaseModel):
    blog_title: str
    audience: str
    tone: str
    blog_kind: Literal["explainer", "tutorial", "news_roundup", "comparison", "system_design"] = "explainer"
    constraints: list[str] = Field(default_factory=list)
    tasks: list[Task] = Field(min_length=3, max_length=8)

class EvidenceItem(BaseModel):
    title: str = ""
    url: str
    published_at: Optional[str] = None
    snippet: Optional[str] = None
    source: Optional[str] = None

class RouterDecision(BaseModel):
    needs_research: bool
    mode: Literal["closed_book", "hybrid", "open_book"]
    queries: list[str] = Field(default_factory=list)

class GraphState(TypedDict, total=False):
    topic: str
    mode: str
    needs_research: bool
    queries: list[str]
    evidence: list[EvidenceItem]
    plan: Optional[Plan]
    sections: Annotated[list[tuple[int, str]], operator.add]
    merged_md: str
    final: str

ROUTER_PROMPT = """You route a technical blog request.
closed_book: evergreen concepts, no current facts needed.
hybrid: evergreen topic needing current tools/examples.
open_book: latest news, pricing, rankings, policy or volatile facts.
If research is needed, return at most 3 specific search queries.
If research is not needed, return an empty query list.
Return the required structured schema."""

PLANNER_PROMPT = """You are a senior technical editor.
Create 4-6 sections for a practical technical blog.
Each section needs a clear goal, 3-5 concrete non-overlapping bullets,
and target_words between 120 and 350.
Include implementation details, edge cases, debugging and cost/performance
where relevant. At least one section should include a minimal code example
when the topic is technical.
For open_book, use news_roundup and do not invent events.
Use only the supplied evidence for current claims.
Return the Plan schema."""

WORKER_PROMPT = """You are a precise senior technical writer.
Write exactly ONE section in Markdown, beginning with ## Section title.
Cover every supplied bullet in order. Stay near the target word count.
Use code fences for code. Avoid fluff.
If citations are required, cite only supplied URLs as Markdown links.
Never invent sources. If evidence does not support a current claim, say so.
Output only the section Markdown."""

def normalize_plan_dict(data: dict, topic: str) -> dict:
    blog_title = data.get("blog_title") or data.get("title") or topic
    audience = data.get("audience") or "Technical professionals and general readers"
    tone = data.get("tone") or "informative and practical"
    blog_kind = data.get("blog_kind") or "explainer"
    if blog_kind not in ["explainer", "tutorial", "news_roundup", "comparison", "system_design"]:
        blog_kind = "news_roundup" if any(w in topic.lower() for w in ["news", "roundup", "top 10"]) else "explainer"
        
    raw_tasks = data.get("tasks") or data.get("sections") or []
    if not isinstance(raw_tasks, list) or len(raw_tasks) == 0:
        raw_tasks = [
            {"id": 1, "title": "Overview & Core Concepts", "goal": f"Introduce the key aspects of {topic}", "bullets": ["Context and background", "Core principles", "Why this matters"], "target_words": 200},
            {"id": 2, "title": "In-Depth Technical Breakdown", "goal": "Analyze the technical mechanics and implementation", "bullets": ["Architecture and components", "Implementation details", "Best practices"], "target_words": 250},
            {"id": 3, "title": "Practical Evaluation & Future Outlook", "goal": "Summarize trade-offs, debugging, and conclusions", "bullets": ["Performance considerations", "Common edge cases", "Summary and next steps"], "target_words": 200}
        ]
        
    normalized_tasks = []
    for idx, t in enumerate(raw_tasks):
        if not isinstance(t, dict):
            continue
        try:
            task_id = int(t.get("id")) if t.get("id") is not None else (idx + 1)
        except (ValueError, TypeError):
            task_id = idx + 1
            
        title = str(t.get("title") or f"Section {idx + 1}").strip()
        goal = str(t.get("goal") or f"Cover {title} in depth").strip()
        
        raw_bullets = t.get("bullets") or []
        if isinstance(raw_bullets, str):
            raw_bullets = [b.strip() for b in raw_bullets.split("\n") if b.strip()]
        elif not isinstance(raw_bullets, list):
            raw_bullets = []
        bullets = [str(b).strip() for b in raw_bullets if str(b).strip()]
        while len(bullets) < 3:
            bullets.append(f"Examine core aspects and implications of {title} (point {len(bullets)+1})")
        bullets = bullets[:6]
        
        try:
            target_words = max(120, min(int(t.get("target_words", 250)), 550))
        except (ValueError, TypeError):
            target_words = 250
            
        normalized_tasks.append({
            "id": task_id,
            "title": title,
            "goal": goal,
            "bullets": bullets,
            "target_words": target_words,
            "tags": t.get("tags") if isinstance(t.get("tags"), list) else [],
            "requires_research": bool(t.get("requires_research", False)),
            "requires_citations": bool(t.get("requires_citations", False)),
            "requires_code": bool(t.get("requires_code", False)),
        })
        
    while len(normalized_tasks) < 3:
        i = len(normalized_tasks) + 1
        normalized_tasks.append({
            "id": i,
            "title": f"Technical Deep-Dive Part {i}",
            "goal": f"Explore further dimensions of {topic}",
            "bullets": ["Technical considerations", "Operational trade-offs", "Recommendations"],
            "target_words": 200,
            "tags": [],
            "requires_research": False,
            "requires_citations": False,
            "requires_code": False
        })
    normalized_tasks = normalized_tasks[:8]
    
    return {
        "blog_title": blog_title,
        "audience": audience,
        "tone": tone,
        "blog_kind": blog_kind,
        "constraints": data.get("constraints") if isinstance(data.get("constraints"), list) else [],
        "tasks": normalized_tasks
    }

def invoke_with_retry(runnable, messages, attempts: int = 5):
    import time
    last_error = None
    for attempt in range(attempts):
        try:
            return runnable.invoke(messages)
        except Exception as exc:
            last_error = exc
            message = str(exc).lower()
            retryable = any(x in message for x in [
                "429", "rate", "quota", "resource_exhausted",
                "temporarily unavailable", "503", "502", "500", "timeout",
                "tool_use_failed", "failed to parse tool call",
                "output_parse_failed", "tool call validation failed"
            ])
            if not retryable or attempt == attempts - 1:
                raise
            
            wait_match = re.search(r"try again in (\d+(\.\d+)?)s", str(exc))
            if wait_match:
                sleep_secs = min(float(wait_match.group(1)) + 1.5, 30.0)
            else:
                sleep_secs = min(3 * (attempt + 1), 22)
                
            print(f"[retry] Attempt {attempt + 1} failed: {exc}. Retrying in {sleep_secs:.1f}s...")
            time.sleep(sleep_secs)
    raise last_error

def router_node(state: GraphState) -> dict:
    if state.get("research_disabled") or not ENABLE_RESEARCH or tavily_client is None:
        return {"needs_research": False, "mode": "closed_book", "queries": []}
    
    try:
        structured = llm.with_structured_output(RouterDecision)
        decision = invoke_with_retry(structured, [
            SystemMessage(content=ROUTER_PROMPT),
            HumanMessage(content=f"Blog topic: {state['topic']}")
        ], attempts=2)
    except Exception as exc:
        print(f"[router] Structured tool call failed ({exc}); falling back to JSON schema...")
        try:
            import json
            raw_llm = getattr(llm, "bound", llm)
            json_llm = raw_llm.bind(response_format={"type": "json_object"}) if hasattr(raw_llm, "bind") else raw_llm
            res = invoke_with_retry(json_llm, [
                SystemMessage(content=ROUTER_PROMPT + '\nYou MUST return a JSON object with keys "needs_research" (bool), "mode" ("closed_book"|"hybrid"|"open_book"), and "queries" (list of strings).'),
                HumanMessage(content=f"Blog topic: {state['topic']}")
            ], attempts=2)
            content = res.content
            if isinstance(content, list):
                content = " ".join(str(c) for c in content)
            match = re.search(r"\{[\s\S]*\}", str(content))
            raw_dict = json.loads(match.group(0)) if match else json.loads(str(content))
            mode = raw_dict.get("mode", "hybrid")
            if mode not in ["closed_book", "hybrid", "open_book"]:
                mode = "hybrid"
            decision = RouterDecision(
                needs_research=bool(raw_dict.get("needs_research", True)),
                mode=mode,
                queries=raw_dict.get("queries") if isinstance(raw_dict.get("queries"), list) else [state['topic'][:100]]
            )
        except Exception:
            decision = RouterDecision(needs_research=True, mode="hybrid", queries=[state['topic'][:100]])
            
    queries = decision.queries[:MAX_RESEARCH_QUERIES] if decision.needs_research else []
    return {
        "needs_research": bool(decision.needs_research and queries),
        "mode": decision.mode if queries else "closed_book",
        "queries": queries,
    }

def route_after_router(state: GraphState) -> str:
    return "research" if state.get("needs_research") else "planner"

def research_node(state: GraphState) -> dict:
    if tavily_client is None:
        return {"evidence": []}
    results_by_url: dict[str, EvidenceItem] = {}
    for query in (state.get("queries") or [])[:MAX_RESEARCH_QUERIES]:
        try:
            response = tavily_client.search(
                query=query,
                max_results=3,
                search_depth="basic",
            )
            for item in response.get("results", []):
                url = item.get("url")
                if not url or url in results_by_url:
                    continue
                results_by_url[url] = EvidenceItem(
                    title=item.get("title") or "",
                    url=url,
                    published_at=item.get("published_date") or item.get("published_at"),
                    snippet=(item.get("content") or "")[:700],
                    source=item.get("source"),
                )
        except Exception as exc:
            print(f"[research] query failed: {exc}")
    return {"evidence": list(results_by_url.values())[:9]}

def planner_node(state: GraphState) -> dict:
    import json
    evidence = [e.model_dump() for e in (state.get("evidence") or [])]
    evidence_prompt = (
        f"Topic: {state['topic']}\n"
        f"Mode: {state.get('mode', 'closed_book')}\n"
        f"Evidence (only for current claims): {evidence[:9]}"
    )
    try:
        planner = llm.with_structured_output(Plan)
        plan = invoke_with_retry(planner, [
            SystemMessage(content=PLANNER_PROMPT),
            HumanMessage(content=evidence_prompt)
        ], attempts=2)
        if plan and isinstance(plan, Plan):
            return {"plan": plan}
    except Exception as exc:
        print(f"[planner] Structured output via tool call failed ({exc}); switching to robust JSON fallback...")

    json_schema_prompt = (
        f"{PLANNER_PROMPT}\n\n"
        "You MUST return your output as a single valid JSON object matching this schema:\n"
        "{\n"
        '  "blog_title": "string",\n'
        '  "audience": "string",\n'
        '  "tone": "string",\n'
        '  "blog_kind": "explainer",\n'
        '  "constraints": [],\n'
        '  "tasks": [\n'
        "    {\n"
        '      "id": 1,\n'
        '      "title": "string",\n'
        '      "goal": "string",\n'
        '      "bullets": ["bullet 1", "bullet 2", "bullet 3"],\n'
        '      "target_words": 200,\n'
        '      "tags": [],\n'
        '      "requires_research": false,\n'
        '      "requires_citations": false,\n'
        '      "requires_code": false\n'
        "    }\n"
        "  ]\n"
        "}\n"
        "Do NOT output markdown code fences or conversational text. Return only the raw JSON object."
    )
    
    try:
        raw_llm = getattr(llm, "bound", llm)
        json_llm = raw_llm.bind(response_format={"type": "json_object"}) if hasattr(raw_llm, "bind") else raw_llm
        res = invoke_with_retry(json_llm, [
            SystemMessage(content=json_schema_prompt),
            HumanMessage(content=evidence_prompt)
        ], attempts=3)
        content = res.content
        if isinstance(content, list):
            content = " ".join(str(c) for c in content)
        content_str = str(content).strip()
        
        json_match = re.search(r"\{[\s\S]*\}", content_str)
        raw_dict = json.loads(json_match.group(0)) if json_match else json.loads(content_str)
        normalized = normalize_plan_dict(raw_dict, state["topic"])
        plan = Plan.model_validate(normalized)
        return {"plan": plan}
    except Exception as fallback_exc:
        print(f"[planner] Direct JSON fallback failed ({fallback_exc}); constructing normalized plan...")
        safe_dict = normalize_plan_dict({}, state["topic"])
        plan = Plan.model_validate(safe_dict)
        return {"plan": plan}

def fanout(state: GraphState):
    plan = state.get("plan")
    if not plan:
        raise ValueError("Planner did not return a plan.")
    return [
        Send("worker", {
            "task": task.model_dump(),
            "topic": state["topic"],
            "mode": state.get("mode", "closed_book"),
            "blog_title": plan.blog_title,
            "audience": plan.audience,
            "tone": plan.tone,
            "blog_kind": plan.blog_kind,
            "constraints": plan.constraints,
            "evidence": [e.model_dump() for e in (state.get("evidence") or [])],
        })
        for task in plan.tasks
    ]

def worker_node(payload: dict) -> dict:
    task = Task(**payload["task"])
    evidence = payload.get("evidence", [])
    evidence_text = "\n".join(
        f"- {e.get('title','')} | {e.get('url','')} | {e.get('snippet','')[:350]}"
        for e in evidence[:9]
    )
    bullets = "\n".join(f"{i+1}. {b}" for i, b in enumerate(task.bullets))
    prompt = (
        f"Topic: {payload['topic']}\n"
        f"Blog title: {payload['blog_title']}\n"
        f"Audience: {payload['audience']}\nTone: {payload['tone']}\n"
        f"Blog kind: {payload['blog_kind']}\nMode: {payload['mode']}\n"
        f"Section title: {task.title}\nGoal: {task.goal}\n"
        f"Target words: {task.target_words}\n"
        f"Requires citations: {task.requires_citations}\n"
        f"Requires code: {task.requires_code}\n"
        f"Bullets:\n{bullets}\n"
        f"Evidence URLs (use only these):\n{evidence_text}"
    )
    response = invoke_with_retry(llm, [
        SystemMessage(content=WORKER_PROMPT),
        HumanMessage(content=prompt)
    ], attempts=5)
    content = response.content
    if isinstance(content, list):
        content = "\n".join(
            part.get("text", "") if isinstance(part, dict) else str(part)
            for part in content
        )
    section = str(content).strip()
    if not section.startswith("## "):
        section = f"## {task.title}\n\n{section}"
    return {"sections": [(task.id, section)]}

def reducer_node(state: GraphState) -> dict:
    plan = state.get("plan")
    if not plan:
        raise ValueError("Cannot merge without a plan.")
    ordered = sorted(state.get("sections", []), key=lambda x: x[0])
    body = "\n\n".join(section for _, section in ordered)
    markdown = f"# {plan.blog_title}\n\n{body}\n"
    return {"merged_md": markdown, "final": markdown}

def build_graph():
    graph = StateGraph(GraphState)
    graph.add_node("router", router_node)
    graph.add_node("research", research_node)
    graph.add_node("planner", planner_node)
    graph.add_node("worker", worker_node)
    graph.add_node("reducer", reducer_node)

    graph.add_edge(START, "router")
    graph.add_conditional_edges(
        "router",
        route_after_router,
        {"research": "research", "planner": "planner"}
    )
    graph.add_edge("research", "planner")
    graph.add_conditional_edges("planner", fanout, ["worker"])
    graph.add_edge("worker", "reducer")
    graph.add_edge("reducer", END)
    return graph.compile()

app_graph = build_graph()

app = FastAPI(title="AI Blog Generator API", version="1.0.0")
jobs: dict[str, dict] = {}
job_tasks: dict[str, asyncio.Task] = {}

class GenerateRequest(BaseModel):
    topic: str = Field(min_length=5, max_length=500)
    research: bool = True

async def run_generation(job_id: str, topic: str, research_enabled: bool):
    jobs[job_id]["status"] = "running"
    jobs[job_id]["stage"] = "Starting LangGraph workflow"
    try:
        initial_state: GraphState = {
            "topic": topic,
            "mode": "closed_book",
            "needs_research": False,
            "queries": [],
            "evidence": [],
            "plan": None,
            "sections": [],
            "merged_md": "",
            "final": "",
        }

        if not research_enabled:
            initial_state["research_disabled"] = True  

        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None,
            lambda: app_graph.invoke(
                initial_state,
                config={
                    "max_concurrency": MAX_WORKERS,
                    "recursion_limit": 30,
                },
            ),
        )

        markdown = result.get("final", "")
        if not markdown:
            raise RuntimeError("The graph completed without producing Markdown.")

        filename = f"{job_id}.md"
        output_path = OUTPUT_DIR / filename
        output_path.write_text(markdown, encoding="utf-8")

        jobs[job_id].update({
            "status": "completed",
            "stage": "Completed",
            "markdown": markdown,
            "filename": filename,
            "download_url": f"/api/jobs/{job_id}/download",
            "completed_at": datetime.now(timezone.utc).isoformat(),
        })
    except Exception as exc:
        jobs[job_id].update({
            "status": "failed",
            "stage": "Failed",
            "error": str(exc),
        })

@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "provider": PROVIDER,
        "max_workers": MAX_WORKERS,
        "research_configured": tavily_client is not None,
    }

@app.post("/api/generate")
async def generate(request: GenerateRequest):
    topic = request.topic.strip()
    if len(topic) < 5:
        raise HTTPException(status_code=422, detail="Please enter a longer topic.")

    job_id = str(uuid.uuid4())
    jobs[job_id] = {
        "job_id": job_id,
        "topic": topic,
        "status": "queued",
        "stage": "Queued",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    task = asyncio.create_task(run_generation(job_id, topic, request.research))
    job_tasks[job_id] = task
    return {"job_id": job_id, "status": "queued"}

@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    response = {k: v for k, v in job.items() if k != "markdown"}
    if job.get("status") == "completed":
        response["markdown"] = job.get("markdown", "")
    return response

@app.get("/api/jobs/{job_id}/download")
async def download_job(job_id: str):
    job = jobs.get(job_id)
    if not job or job.get("status") != "completed":
        raise HTTPException(status_code=404, detail="Completed output not found.")
    path = OUTPUT_DIR / job["filename"]
    if not path.exists():
        raise HTTPException(status_code=404, detail="Output file is missing.")
    return FileResponse(path, media_type="text/markdown", filename=job["filename"])

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/")
async def home():
    return FileResponse(STATIC_DIR / "index.html")

if __name__ == "__main__":
    import uvicorn
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "8000"))
    print(f"\nAI Blog Generator running at http://{host}:{port}")
    print("Frontend and API are served by this same backend process.\n")
    uvicorn.run(app, host=host, port=port, reload=False)