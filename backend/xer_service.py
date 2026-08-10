"""
XER 解析服务 - 直接解析 Primavera P6 的 .xer 文件表格
不依赖 xerparser 的高层 schema 校验（它要求 40+ 必填字段），
而是用底层 parser 提取原始表数据，自行映射。

提供：任务树（WBS + 活动）、依赖关系、日期范围
"""
from datetime import datetime


def _parse_xer_date(val) -> str:
    """把 XER 里的日期字符串转成 'YYYY-MM-DD'。容忍多种格式和空值。"""
    if not val:
        return ""
    val = str(val).strip()
    if not val or val == "0":
        return ""
    # 常见格式：%Y-%m-%d %H:%M, %Y-%m-%d
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d", "%Y%m%d", "%m/%d/%Y"):
        try:
            return datetime.strptime(val, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    # 截断尝试
    if len(val) >= 10:
        return val[:10]
    return ""


class XerService:
    """XER 文件解析器，单例缓存"""

    def __init__(self):
        self._tables = None    # dict: table_name -> list[dict]
        self._parsed = None    # {tasks, links, dateRange}

    # ------------------------------------------------------------------ #
    #  加载
    # ------------------------------------------------------------------ #
    def load(self, file_path: str):
        """加载 XER 文件，返回解析结果 {tasks, links, dateRange}"""
        # 优先用 UTF-8 读取（支持中文任务名），失败再用 cp1252
        self._tables = self._fallback_parse(file_path)

        self._parsed = self._parse()
        return self._parsed

    def _fallback_parse(self, file_path: str) -> dict:
        """不依赖 xerparser 的极简 XER 解析器，优先 UTF-8 支持中文"""
        # P6 导出的 XER 通常是 cp1252/latin1，但用户自建的可能含中文(UTF-8)
        # 先尝试 UTF-8，失败再 cp1252
        content = None
        for enc in ("utf-8", "cp1252", "latin-1"):
            try:
                with open(file_path, encoding=enc) as f:
                    content = f.read()
                break  # 成功读取就用这个编码
            except (UnicodeDecodeError, OSError):
                continue
        if content is None:
            with open(file_path, encoding="utf-8", errors="ignore") as f:
                content = f.read()

        tables = {}
        for block in content.split("%T\t"):
            block = block.strip()
            if not block:
                continue
            lines = block.split("\n")
            name = lines[0].strip()
            if name == "ERMHDR" or not lines[1:]:
                tables["ERMHDR"] = []
                continue
            cols_line = lines[1]
            cols = cols_line.split("\t")
            if cols and cols[0] == "%F":
                cols = cols[1:]
            rows = []
            for line in lines[2:]:
                if line.startswith("%R\t") or line == "%R":
                    vals = line.split("\t")[1:]
                    rows.append(dict(zip(cols, vals)))
            tables[name] = rows
        return tables

    @property
    def is_loaded(self) -> bool:
        return self._tables is not None

    # ------------------------------------------------------------------ #
    #  解析主逻辑
    # ------------------------------------------------------------------ #
    def _parse(self) -> dict:
        tasks = []
        links = []

        # ---- 1) WBS 节点 ----
        wbs_rows = self._tables.get("PROJWBS", [])
        wbs_map = {}  # wbs_id -> gantt_id
        for row in wbs_rows:
            wbs_id = row.get("wbs_id", "")
            gid = f"wbs_{wbs_id}"
            wbs_map[wbs_id] = gid
            name = row.get("wbs_name") or row.get("wbs_short_name") or "WBS"
            tasks.append({
                "id": gid,
                "text": name,
                "start_date": "",
                "duration": 0,
                "parent": "",  # 下面修正
                "progress": 0,
                "open": True,
                "type": "project",
                "isWbs": True,
                "wbsCode": row.get("wbs_short_name", ""),
            })
        # 修正 WBS parent
        for row in wbs_rows:
            parent_id = row.get("parent_wbs_id") or row.get("par_wbs_id") or ""
            gid = wbs_map.get(row.get("wbs_id", ""))
            pgid = wbs_map.get(parent_id, "") if parent_id else ""
            for t in tasks:
                if t["id"] == gid:
                    t["parent"] = pgid
                    break

        # ---- 2) 活动（TASK 表）----
        task_rows = self._tables.get("TASK", [])
        # 只取被导出的项目的任务（PROJECT 表中 export_flag=Y）
        exported_proj_ids = {
            p.get("proj_id")
            for p in self._tables.get("PROJECT", [])
            if p.get("export_flag", "Y") == "Y"
        }

        for idx, row in enumerate(task_rows):
            proj_id = row.get("proj_id", "")
            if exported_proj_ids and proj_id not in exported_proj_ids:
                continue

            task_id = row.get("task_id", f"t{idx}")
            gid = f"task_{task_id}"

            # 日期：优先 target（计划），其次 early（计算），最后 act（实际）
            start = (
                _parse_xer_date(row.get("target_start_date"))
                or _parse_xer_date(row.get("early_start_date"))
                or _parse_xer_date(row.get("act_start_date"))
            )
            finish = (
                _parse_xer_date(row.get("target_end_date"))
                or _parse_xer_date(row.get("early_end_date"))
                or _parse_xer_date(row.get("act_end_date"))
            )
            # 工期：target_drtn_hr_cnt 是小时数，除以 8 转工作日
            dur_hr = row.get("target_drtn_hr_cnt") or row.get("act_work_qty") or "8"
            try:
                duration = max(int(float(dur_hr) / 8), 1) if dur_hr else 1
            except (ValueError, TypeError):
                duration = 1

            code = row.get("task_code", "")
            name = row.get("task_name", "") or "活动"
            wbs_id = row.get("wbs_id", "")
            parent_gid = wbs_map.get(wbs_id, "") if wbs_id else ""

            # 进度状态
            status = row.get("status_code", "")
            progress = 0
            if status == "AA":  # Completed
                progress = 1
            elif status == "WK":  # In Progress
                progress = 0.5
            # 也看 phys_complete_pct
            try:
                pct = float((row.get("phys_complete_pct") or "0").replace(",", "."))
                if pct > progress * 100:
                    progress = pct / 100
            except (ValueError, TypeError):
                pass

            tasks.append({
                "id": gid,
                "text": f"{code} {name}".strip(),
                "start_date": start,
                "duration": duration if start else 0,
                "parent": parent_gid,
                "progress": progress,
                "open": True,
                "type": "task",
                "isWbs": False,
                "taskCode": code,
                "taskName": name,
                "startDate": start,
                "finishDate": finish,
                "status": status,
            })

        # ---- 3) 依赖关系（TASKPRED 表）----
        rel_rows = self._tables.get("TASKPRED", [])
        rel_type_map = {"FS": "0", "SS": "1", "FF": "2", "SF": "3"}
        for row in rel_rows:
            pred_id = row.get("pred_task_id", "")
            succ_id = row.get("task_id", "")
            pred_gid = f"task_{pred_id}" if pred_id else ""
            succ_gid = f"task_{succ_id}" if succ_id else ""
            if not pred_gid or not succ_gid:
                continue
            rtype = (row.get("pred_type") or "FS").upper()[:2]
            links.append({
                "id": f"link_{pred_gid}_{succ_gid}",
                "source": pred_gid,
                "target": succ_gid,
                "type": rel_type_map.get(rtype, "0"),
                "relType": rtype,
            })

        # 排序：WBS 在前，其下叶子任务按开始日期排
        wbs_items = [t for t in tasks if t.get("isWbs")]
        leaf_map = {}  # parent -> [tasks]
        for t in tasks:
            if not t.get("isWbs"):
                p = t.get("parent", "")
                leaf_map.setdefault(p, []).append(t)
        for k in leaf_map:
            leaf_map[k].sort(key=lambda t: t.get("startDate", "") or "9999-99-99")
        sorted_tasks = []
        for wbs in wbs_items:
            sorted_tasks.append(wbs)
            children = leaf_map.get(wbs["id"], [])
            sorted_tasks.extend(children)
        # 没有父节点的叶子任务放最后
        orphans = leaf_map.get("", [])
        sorted_tasks.extend(orphans)
        tasks = sorted_tasks

        # ---- 4) 日期范围 ----
        date_range = self._compute_date_range(tasks)

        return {"tasks": tasks, "links": links, "dateRange": date_range}

    def _compute_date_range(self, tasks: list) -> dict:
        starts, finishes = [], []
        for t in tasks:
            if t.get("isWbs"):
                continue
            s = t.get("startDate")
            f = t.get("finishDate")
            if s:
                starts.append(s)
            if f:
                finishes.append(f)
        return {
            "start": min(starts) if starts else "",
            "finish": max(finishes) if finishes else "",
        }

    # ------------------------------------------------------------------ #
    #  对外查询
    # ------------------------------------------------------------------ #
    def get_tasks(self) -> dict:
        if self._parsed is None:
            return {"tasks": [], "links": [], "dateRange": {}}
        return self._parsed
