"""
任务-构件关联服务
负责：存储关联、自动匹配（按关键词）、按日期计算构件状态
"""
import uuid

# 关键词 -> IFC 类型 映射（中英文）
KEYWORD_TYPE_MAP = {
    "墙": "Wall", "wall": "Wall", "砌": "Wall",
    "柱": "Column", "column": "Column", "柱子": "Column",
    "梁": "Beam", "beam": "Beam",
    "板": "Slab", "slab": "Slab", "楼板": "Slab", "floor": "Slab",
    "门": "Door", "door": "Door",
    "窗": "Window", "window": "Window",
    "屋顶": "Roof", "roof": "Roof",
    "楼梯": "Stair", "stair": "Stair",
    "栏杆": "Railing", "railing": "Railing",
    "基础": "Footing", "footing": "Footing", "承台": "Footing",
    "幕墙": "CurtainWall", "curtain": "CurtainWall",
    "屋面": "Roof",
    "顶": "Slab",  # 吊顶、顶板等
}


class LinkingService:
    """关联管理 + 自动匹配 + 状态计算"""

    def __init__(self):
        # links: list of {id, taskId, elementGuid}
        self._links = []
        # 反向索引：elementGuid -> set(taskId)
        self._elem_to_tasks = {}
        # 正向索引：taskId -> set(elementGuid)
        self._task_to_elems = {}

    # ------------------------------------------------------------------ #
    #  关联 CRUD
    # ------------------------------------------------------------------ #
    def add_link(self, task_id: str, element_guid: str) -> dict:
        if not task_id or not element_guid:
            return {"error": "taskId 和 elementGuid 不能为空"}
        # 去重
        existing = next(
            (l for l in self._links
             if l["taskId"] == task_id and l["elementGuid"] == element_guid),
            None,
        )
        if existing:
            return existing
        link = {
            "id": str(uuid.uuid4()),
            "taskId": task_id,
            "elementGuid": element_guid,
        }
        self._links.append(link)
        self._elem_to_tasks.setdefault(element_guid, set()).add(task_id)
        self._task_to_elems.setdefault(task_id, set()).add(element_guid)
        return link

    def remove_link(self, link_id: str) -> bool:
        before = len(self._links)
        link = next((l for l in self._links if l["id"] == link_id), None)
        if not link:
            return False
        self._links = [l for l in self._links if l["id"] != link_id]
        if link["elementGuid"] in self._elem_to_tasks:
            self._elem_to_tasks[link["elementGuid"]].discard(link["taskId"])
        if link["taskId"] in self._task_to_elems:
            self._task_to_elems[link["taskId"]].discard(link["elementGuid"])
        return len(self._links) < before

    def remove_links_for_task(self, task_id: str) -> int:
        count = 0
        to_remove = [l for l in self._links if l["taskId"] == task_id]
        for l in to_remove:
            if self.remove_link(l["id"]):
                count += 1
        return count

    def get_links(self) -> list:
        return list(self._links)

    def get_elements_for_task(self, task_id: str) -> list:
        return list(self._task_to_elems.get(task_id, set()))

    def get_tasks_for_element(self, element_guid: str) -> list:
        return list(self._elem_to_tasks.get(element_guid, set()))

    # ------------------------------------------------------------------ #
    #  自动匹配
    # ------------------------------------------------------------------ #
    def auto_link(self, elements: list, tasks: list, apply: bool = False) -> dict:
        """
        根据任务名关键词匹配 IFC 构件类型。
        elements: [{guid, name, type, floor, ...}]
        tasks:    [{id, text/taskName, ...}]
        apply:    True 则直接创建关联，False 只返回建议
        返回：{suggestions: [...], appliedCount}
        """
        suggestions = []
        applied = 0

        # 按 (类型, 楼层) 建索引，加速查找
        elems_by_type_floor = {}
        for e in elements:
            key = (e.get("type", ""), e.get("floor", ""))
            elems_by_type_floor.setdefault(key, []).append(e)
        # 也按类型（不限楼层）建索引
        elems_by_type = {}
        for e in elements:
            elems_by_type.setdefault(e.get("type", ""), []).append(e)

        for task in tasks:
            if task.get("isWbs"):
                continue
            # 任务名：taskName 或 text
            name = task.get("taskName") or task.get("text") or ""
            task_id = task["id"]

            matched_type = self._match_keyword(name)
            if not matched_type:
                continue

            # 楼层匹配（从任务名里找楼层线索，如 "1层"/"L2"/"F3"）
            floor = self._guess_floor(name)

            candidates = []
            if floor:
                candidates = elems_by_type_floor.get((matched_type, floor), [])
            if not candidates:
                candidates = elems_by_type.get(matched_type, [])

            if not candidates:
                continue

            for e in candidates:
                suggestions.append({
                    "taskId": task_id,
                    "taskName": name,
                    "elementGuid": e["guid"],
                    "elementName": e.get("name", ""),
                    "elementType": e.get("type", ""),
                    "elementFloor": e.get("floor", ""),
                    "matchedBy": f"keyword:{matched_type}",
                })
                if apply:
                    self.add_link(task_id, e["guid"])
                    applied += 1

        return {"suggestions": suggestions, "appliedCount": applied}

    @staticmethod
    def _match_keyword(name: str) -> str | None:
        for kw, ifc_type in KEYWORD_TYPE_MAP.items():
            if kw in name:
                return ifc_type
        return None

    @staticmethod
    def _guess_floor(name: str) -> str:
        """从任务名推断楼层关键词，用于匹配 IFC 构件的 floor 字段"""
        import re
        # 中文：1层 / 一层 / F1 / L1 / 地下一层 / B1
        m = re.search(r"(\d+)\s*层", name)
        if m:
            return m.group(1) + "层"
        m = re.search(r"[FL](\d+)", name, re.IGNORECASE)
        if m:
            return m.group(1)
        m = re.search(r"[Bb](\d+)", name)
        if m:
            return "B" + m.group(1)
        return ""

    # ------------------------------------------------------------------ #
    #  4D 状态计算
    # ------------------------------------------------------------------ #
    def compute_states(self, tasks: list, sim_date: str) -> dict:
        """
        给定模拟日期，计算每个被关联构件的状态。
        tasks: [{id, startDate, finishDate, ...}]
        返回：{ elementGuid: "done"|"active"|"pending" }
        """
        if not sim_date:
            return {}

        task_by_id = {t["id"]: t for t in tasks}
        result = {}

        for elem_guid, task_ids in self._elem_to_tasks.items():
            # 一个构件可能关联多个任务，取"最接近施工中"的状态
            state = "pending"  # 默认未开始
            for tid in task_ids:
                task = task_by_id.get(tid)
                if not task:
                    continue
                start = task.get("startDate", "")
                finish = task.get("finishDate", "")
                if not start or not finish:
                    continue
                if sim_date > finish:
                    s = "done"
                elif sim_date < start:
                    s = "pending"
                else:
                    s = "active"
                # active 优先级最高，done 次之
                if s == "active" or (state == "pending" and s == "done"):
                    state = s
            result[elem_guid] = state

        return result
