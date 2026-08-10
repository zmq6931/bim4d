"""
BIM 4D 模拟软件 - FastAPI 后端入口
启动：uvicorn main:app --reload --port 8000
"""
import os
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, UploadFile, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from ifc_service import IfcService
from xer_service import XerService
from linking_service import LinkingService

# ---------------------------------------------------------------------- #
#  全局服务实例（内存态）
# ---------------------------------------------------------------------- #
ifc_svc = IfcService()
xer_svc = XerService()
link_svc = LinkingService()

app = FastAPI(title="BIM 4D 模拟", version="1.0.0")

# CORS（开发期放开，方便前端调试）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# 静态前端目录（启动后访问 http://localhost:8000/ 即打开界面）
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
if FRONTEND_DIR.exists():
    app.mount("/app", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")


@app.get("/")
async def root():
    """根路径返回前端页面"""
    index = FRONTEND_DIR / "index.html"
    if index.exists():
        return FileResponse(str(index))
    return {"message": "BIM 4D 后端已启动。请放置前端文件到 frontend/ 目录。"}


# ---------------------------------------------------------------------- #
#  状态查询
# ---------------------------------------------------------------------- #
@app.get("/api/status")
async def status():
    return {
        "ifcLoaded": ifc_svc.is_loaded,
        "xerLoaded": xer_svc.is_loaded,
        "linkCount": len(link_svc.get_links()),
    }


# ---------------------------------------------------------------------- #
#  上传 & 解析
# ---------------------------------------------------------------------- #
@app.post("/api/upload/ifc")
async def upload_ifc(file: UploadFile = File(...)):
    if not file.filename.lower().endswith((".ifc", ".ifcxml", ".ifczip")):
        raise HTTPException(400, "请上传 .ifc 格式文件")
    suffix = Path(file.filename).suffix
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name
    try:
        elements = ifc_svc.load(tmp_path)
        return {
            "message": f"IFC 解析完成，共 {len(elements)} 个构件",
            "elementCount": len(elements),
            "elements": elements[:200],  # 首批返回前 200 条，其余用 /api/elements 拉
            "totalElements": len(elements),
        }
    except Exception as e:
        raise HTTPException(500, f"IFC 解析失败: {e}")
    finally:
        # 保留临时文件（IfcService 已缓存 model 对象，但底层仍读文件）
        # 不立即删除，避免 IfcOpenShell 延迟读取失败
        pass


@app.post("/api/upload/xer")
async def upload_xer(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".xer"):
        raise HTTPException(400, "请上传 .xer 格式文件")
    with tempfile.NamedTemporaryFile(delete=False, suffix=".xer") as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name
    try:
        parsed = xer_svc.load(tmp_path)
        return {
            "message": f"XER 解析完成，共 {len(parsed['tasks'])} 个任务，"
                       f"{len(parsed['links'])} 个依赖",
            "taskCount": len(parsed["tasks"]),
            "linkCount": len(parsed["links"]),
            "tasks": parsed["tasks"],
            "links": parsed["links"],
            "dateRange": parsed["dateRange"],
        }
    except Exception as e:
        raise HTTPException(500, f"XER 解析失败: {e}")


# ---------------------------------------------------------------------- #
#  构件 / 任务查询
# ---------------------------------------------------------------------- #
@app.get("/api/elements")
async def get_elements():
    if not ifc_svc.is_loaded:
        raise HTTPException(400, "请先上传 IFC 文件")
    return ifc_svc.get_elements()


@app.get("/api/element/{guid}/geometry")
async def get_element_geometry(guid: str):
    if not ifc_svc.is_loaded:
        raise HTTPException(400, "请先上传 IFC 文件")
    geom = ifc_svc.get_geometry(guid)
    if geom is None:
        raise HTTPException(404, f"未找到构件 {guid}")
    return geom


@app.get("/api/tasks")
async def get_tasks():
    if not xer_svc.is_loaded:
        raise HTTPException(400, "请先上传 XER 文件")
    return xer_svc.get_tasks()


# ---------------------------------------------------------------------- #
#  关联管理
# ---------------------------------------------------------------------- #
@app.get("/api/links")
async def get_links():
    return link_svc.get_links()


@app.post("/api/link")
async def add_link(body: dict):
    link = link_svc.add_link(body.get("taskId", ""), body.get("elementGuid", ""))
    if "error" in link:
        raise HTTPException(400, link["error"])
    return link


@app.post("/api/link/batch")
async def add_links_batch(body: dict):
    """批量创建关联 body: {links: [{taskId, elementGuid}, ...]}"""
    pairs = body.get("links", [])
    created = []
    for p in pairs:
        link = link_svc.add_link(p.get("taskId", ""), p.get("elementGuid", ""))
        if "error" not in link:
            created.append(link)
    return {"created": len(created), "links": created}


@app.delete("/api/link/{link_id}")
async def delete_link(link_id: str):
    ok = link_svc.remove_link(link_id)
    if not ok:
        raise HTTPException(404, "关联不存在")
    return {"deleted": True}


@app.delete("/api/links/task/{task_id}")
async def delete_links_for_task(task_id: str):
    n = link_svc.remove_links_for_task(task_id)
    return {"deleted": n}


# ---------------------------------------------------------------------- #
#  自动关联
# ---------------------------------------------------------------------- #
@app.post("/api/auto-link")
async def auto_link(body: dict | None = None):
    """
    body: {apply: false}  false=只预览建议，true=直接应用
    """
    if not ifc_svc.is_loaded or not xer_svc.is_loaded:
        raise HTTPException(400, "请先上传 IFC 和 XER 文件")
    apply = bool((body or {}).get("apply", False))
    elements = ifc_svc.get_elements()
    tasks = xer_svc.get_tasks()["tasks"]
    return link_svc.auto_link(elements, tasks, apply=apply)


# ---------------------------------------------------------------------- #
#  4D 仿真
# ---------------------------------------------------------------------- #
@app.get("/api/simulation")
async def simulation(date: str = Query(..., description="YYYY-MM-DD")):
    """
    给定日期，返回所有被关联构件的状态。
    状态：done | active | pending
    """
    if not xer_svc.is_loaded:
        raise HTTPException(400, "请先上传 XER 文件")
    tasks = xer_svc.get_tasks()["tasks"]
    states = link_svc.compute_states(tasks, date)
    return {
        "date": date,
        "states": states,
        "linkedCount": len(states),
        "doneCount": sum(1 for v in states.values() if v == "done"),
        "activeCount": sum(1 for v in states.values() if v == "active"),
        "pendingCount": sum(1 for v in states.values() if v == "pending"),
    }


# ---------------------------------------------------------------------- #
#  启动
# ---------------------------------------------------------------------- #
if __name__ == "__main__":
    import uvicorn
    print("=" * 60)
    print("  BIM 4D 模拟软件 启动中...")
    print("  打开浏览器访问: http://localhost:8000")
    print("=" * 60)
    uvicorn.run(app, host="0.0.0.0", port=8000)
