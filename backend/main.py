"""FastAPI 入口：REST API + 静态前端。"""
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from .database import get_conn, init_db
from .scheduler import compute_schedule, would_cycle

FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend")


@asynccontextmanager
async def lifespan(_app):
    init_db()
    yield


app = FastAPI(title="舞台排演提示单", lifespan=lifespan)


# ---------- 请求模型 ----------

class CueIn(BaseModel):
    department: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=200)
    duration: int = Field(ge=1)
    locked_start: int | None = Field(default=None, ge=0)

    @field_validator("department", "name")
    @classmethod
    def not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("不能为空")
        return v


class DepIn(BaseModel):
    depends_on: int
    delay: int = Field(default=0, ge=0)


# ---------- 数据装载与响应组装 ----------

def load_all():
    with get_conn() as conn:
        cues = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM cues ORDER BY id")}
        edges = conn.execute(
            "SELECT id, cue_id, depends_on, delay FROM dependencies ORDER BY id"
        ).fetchall()
    return cues, edges


def build_payload():
    cues, edges = load_all()
    schedule = compute_schedule(
        {cid: {"duration": c["duration"], "locked_start": c["locked_start"]} for cid, c in cues.items()},
        [(e["cue_id"], e["depends_on"], e["delay"]) for e in edges],
    )
    deps_by_cue = {}
    for e in edges:
        deps_by_cue.setdefault(e["cue_id"], []).append(
            {"id": e["id"], "depends_on": e["depends_on"], "delay": e["delay"]}
        )
    out = []
    for cid, c in cues.items():
        s = schedule[cid]
        out.append({
            "id": cid,
            "department": c["department"],
            "name": c["name"],
            "duration": c["duration"],
            "locked_start": c["locked_start"],
            "start": s["start"],
            "end": s["end"],
            "earliest": s["earliest"],
            "conflict": s["conflict"],
            "conflict_chain": s["conflict_chain"],
            "dependencies": deps_by_cue.get(cid, []),
        })
    return {"cues": out, "departments": sorted({c["department"] for c in cues.values()})}


# ---------- API ----------

@app.get("/api/cues")
def list_cues():
    return build_payload()


@app.post("/api/cues", status_code=201)
def create_cue(body: CueIn):
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO cues (department, name, duration, locked_start) VALUES (?,?,?,?)",
            (body.department, body.name, body.duration, body.locked_start),
        )
    return {"id": cur.lastrowid}


@app.put("/api/cues/{cue_id}")
def update_cue(cue_id: int, body: CueIn):
    with get_conn() as conn:
        cur = conn.execute(
            "UPDATE cues SET department=?, name=?, duration=?, locked_start=? WHERE id=?",
            (body.department, body.name, body.duration, body.locked_start, cue_id),
        )
    if cur.rowcount == 0:
        raise HTTPException(404, "提示不存在")
    return {"ok": True}


@app.delete("/api/cues/{cue_id}", status_code=204)
def delete_cue(cue_id: int):
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM cues WHERE id=?", (cue_id,))
    if cur.rowcount == 0:
        raise HTTPException(404, "提示不存在")


@app.post("/api/cues/{cue_id}/dependencies", status_code=201)
def add_dependency(cue_id: int, body: DepIn):
    if body.depends_on == cue_id:
        raise HTTPException(409, "提示不能依赖自身")
    cues, edges = load_all()
    if cue_id not in cues or body.depends_on not in cues:
        raise HTTPException(404, "提示不存在")
    if any(e["cue_id"] == cue_id and e["depends_on"] == body.depends_on for e in edges):
        raise HTTPException(409, "该依赖已存在")
    if would_cycle([(e["cue_id"], e["depends_on"]) for e in edges], cue_id, body.depends_on):
        raise HTTPException(409, "新增该依赖会形成循环，已拒绝")
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO dependencies (cue_id, depends_on, delay) VALUES (?,?,?)",
            (cue_id, body.depends_on, body.delay),
        )
    return {"id": cur.lastrowid}


@app.delete("/api/cues/{cue_id}/dependencies/{dep_id}", status_code=204)
def remove_dependency(cue_id: int, dep_id: int):
    with get_conn() as conn:
        cur = conn.execute(
            "DELETE FROM dependencies WHERE id=? AND cue_id=?", (dep_id, cue_id)
        )
    if cur.rowcount == 0:
        raise HTTPException(404, "依赖不存在")


# 静态前端（挂在最后，API 路由优先匹配）
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
