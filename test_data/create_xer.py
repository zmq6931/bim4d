"""
生成测试 XER 文件（Primavera P6 格式）
后端 xer_service 直接用底层表解析，不依赖 xerparser 严格校验，
所以只需包含必要的表和字段即可。
任务名含中文关键词（墙/柱/板）便于测试自动关联。
"""
import os
from datetime import datetime, timedelta

OUTPUT = os.path.join(os.path.dirname(__file__), "sample_schedule.xer")


def make_xer():
    lines = []
    # ERMHDR 文件头（底层 parser 只检查是否以 ERMHDR 开头）
    lines.append("ERMHDR\t20.12\t2024-01-01\t\t\tBIM4D\t\t\tUSD\t\t\t")

    project_id = "TEST"
    wbs_id_root = "WBS_ROOT"
    task_seq = 100

    # ---- PROJECT 表 ----
    lines.append("%T\tPROJECT")
    lines.append("%F\tproj_id\tproj_short_name\texport_flag")
    lines.append(f"%R\t{project_id}\tBIM4D-Test\tY")

    # ---- PROJWBS 表 ----
    lines.append("%T\tPROJWBS")
    lines.append("%F\twbs_id\tparent_wbs_id\tproj_id\twbs_short_name\twbs_name")
    lines.append(f"%R\t{wbs_id_root}\t\t{project_id}\tBIM4D-Test\t测试项目")
    wbs_f1 = "WBS_F1"
    wbs_f2 = "WBS_F2"
    lines.append(f"%R\t{wbs_f1}\t{wbs_id_root}\t{project_id}\tFoundation\t基础工程")
    lines.append(f"%R\t{wbs_f2}\t{wbs_id_root}\t{project_id}\tMainStructure\t主体结构")

    # ---- TASK 表（活动）----
    lines.append("%T\tTASK")
    lines.append(
        "%F\ttask_id\tproj_id\twbs_id\ttask_code\ttask_name\tstatus_code\t"
        "target_start_date\ttarget_end_date\ttarget_drtn_hr_cnt"
    )

    base = datetime(2024, 1, 15)
    # 任务名含中文关键词（墙/楼板）便于自动关联测试
    tasks = [
        # (wbs, code, name, start_offset, duration_days, status)
        (wbs_f1, "A1000", "1层土方开挖",      0,  5, "WK"),
        (wbs_f1, "A1010", "基础混凝土浇筑",    5,  7, "WK"),
        (wbs_f1, "A1020", "1层楼板1施工",    12,  5, "WK"),
        (wbs_f1, "A1030", "1层楼板2施工",    17,  5, "WK"),
        (wbs_f1, "A1040", "1层墙体砌筑",     22, 12, "WK"),
        (wbs_f1, "A1050", "1层墙A砌筑",      22,  4, "WK"),
        (wbs_f1, "A1060", "1层墙B砌筑",      26,  4, "WK"),
        (wbs_f1, "A1070", "1层墙C砌筑",      30,  4, "WK"),
        (wbs_f2, "A2000", "二层楼板施工",     34,  8, "PL"),
        (wbs_f2, "A2010", "二层墙体砌筑",     42, 12, "PL"),
        (wbs_f2, "A2020", "二层墙A砌筑",      42,  4, "PL"),
        (wbs_f2, "A2030", "二层墙B砌筑",      46,  4, "PL"),
        (wbs_f2, "A2040", "二层墙C砌筑",      50,  4, "PL"),
    ]

    task_ids = []
    for wbs, code, name, off, dur, status in tasks:
        start = base + timedelta(days=off)
        end = start + timedelta(days=dur)
        lines.append(
            f"%R\tT{task_seq}\t{project_id}\t{wbs}\t{code}\t{name}\t{status}\t"
            f"{start.strftime('%Y-%m-%d 08:00')}\t{end.strftime('%Y-%m-%d 17:00')}\t"
            f"{dur * 8}"
        )
        task_ids.append(f"T{task_seq}")
        task_seq += 1

    # ---- TASKPRED 表（依赖关系）----
    lines.append("%T\tTASKPRED")
    lines.append("%F\ttask_pred_id\tpred_task_id\ttask_id\tpred_type")
    deps = [(1, 2), (2, 3), (3, 5), (4, 5), (5, 9), (9, 10)]
    for i, (pred_idx, succ_idx) in enumerate(deps, 1):
        lines.append(
            f"%R\tP{i}\t{task_ids[pred_idx-1]}\t{task_ids[succ_idx-1]}\tFS"
        )

    content = "\n".join(lines) + "\n"
    # 用 UTF-8（后端 parser 也容错读取）
    with open(OUTPUT, "w", encoding="utf-8") as f:
        f.write(content)

    print(f"XER test file generated: {OUTPUT}")
    print(f"  Activities: {len(tasks)}")
    print(f"  Dependencies: {len(deps)}")


if __name__ == "__main__":
    make_xer()
