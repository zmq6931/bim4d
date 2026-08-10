/**
 * dhtmlxGantt 甘特图封装
 * 负责：渲染任务树+依赖、选中任务联动、模拟日期标记线
 *
 * 暴露到 window.BIMGantt
 */
(function () {
    "use strict";

    const BIMGantt = {
        _initialized: false,
        _tasks: [],
        _taskClickCallback: null,
        _timelineClickCallback: null,
        _taskUpdateCallback: null,

        init(containerId) {
            if (this._initialized) return;

            gantt.config.date_format = "%Y-%m-%d";
            gantt.config.row_height = 28;
            gantt.config.bar_height = 20;
            gantt.config.grid_width = 320;
            gantt.config.autosize = false;
            gantt.config.fit_tasks = true;
            gantt.config.show_progress = true;
            gantt.config.drag_move = false;       // 禁止拖动改日期
            gantt.config.drag_progress = false;
            gantt.config.drag_resize = false;
            gantt.config.drag_links = true;       // 允许拖拽创建任务依赖线
            gantt.config.smart_rendering = true;
            gantt.config.smart_scales = true;
            gantt.config.order_branch = true;       // 按日期排序同层级任务

            // 列定义
            gantt.config.columns = [
                {
                    name: "text", label: "Task", tree: true, width: 220,
                    resize: true,
                },
                {
                    name: "startDate", label: "Start", align: "center",
                    width: 70, template: (t) => t.startDate || "—",
                },
                {
                    name: "finishDate", label: "Finish", align: "center",
                    width: 70, template: (t) => t.finishDate || "—",
                },
            ];

            // Date scales
            gantt.config.scales = [
                { unit: "month", step: 1, format: "%M, %Y" },
                { unit: "day", step: 1, format: "%j" },
            ];
            gantt.config.min_column_width = 28;

            // 标记线插件
            gantt.plugins({
                marker: true,
            });

            // 任务点击
            gantt.attachEvent("onTaskClick", (id, e) => {
                const task = gantt.getTask(id);
                if (this._taskClickCallback && !task.isWbs) {
                    this._taskClickCallback(id, task);
                }
                return true;
            });

            // 点击甘特图时间轴 → 跳转模拟日期
            gantt.attachEvent("onGanttClick", (e) => {
                if (!this._timelineClickCallback) return true;
                const date = gantt.getState().date;
                if (date) {
                    const ds = gantt.date.date_to_str("%Y-%m-%d")(date);
                    this._timelineClickCallback(ds);
                }
                return true;
            });

            // 任务时间被编辑 → 通知 app 刷新模拟状态
            gantt.attachEvent("onAfterTaskUpdate", (id, task) => {
                if (this._taskUpdateCallback) this._taskUpdateCallback(id, task);
            });

            // 依赖线操作事件（记录变更，目前仅内存生效）
            gantt.attachEvent("onAfterLinkAdd", (id, link) => {
                // 新依赖线创建
            });
            gantt.attachEvent("onAfterLinkUpdate", (id, link) => {
                // 依赖线修改
            });
            gantt.attachEvent("onAfterLinkDelete", (id, link) => {
                // 依赖线删除
            });

            gantt.init(containerId);
            this._initialized = true;
        },

        /**
         * 加载任务数据
         * @param {Array} tasks - [{id, text, start_date, duration, parent, ...}]
         * @param {Array} links - [{id, source, target, type}]
         * @param {Object} dateRange - {start, finish}
         */
        loadData(tasks, links, dateRange) {
            if (!this._initialized) return;

            // 确保 WBS 行有合法日期（取子任务范围），否则 dhtmlx 报错
            this._tasks = tasks;
            const cleaned = tasks.map((t) => {
                const out = { ...t };
                if (t.isWbs) {
                    // WBS 行用 project 类型，dhtmlx 会自动算范围
                    out.type = "project";
                    out.start_date = null;
                    out.duration = null;
                    out.unscheduled = true;
                } else {
                    // 叶子任务必须有日期才能显示
                    if (t.start_date) {
                        out.start_date = gantt.date.parseDate(t.start_date, "%Y-%m-%d");
                    }
                    if (!out.start_date) {
                        out.unscheduled = true;
                    }
                    out.duration = t.duration || 1;
                }
                return out;
            });

            gantt.clearAll();
            gantt.parse({ data: cleaned, links: links || [] });

            // 设置时间轴范围
            if (dateRange && dateRange.start && dateRange.finish) {
                const start = gantt.date.parseDate(dateRange.start, "%Y-%m-%d");
                const end = gantt.date.parseDate(dateRange.finish, "%Y-%m-%d");
                // 前后各留一点余量
                gantt.config.start_date = gantt.date.add(start, -7, "day");
                gantt.config.end_date = gantt.date.add(end, 7, "day");
                gantt.render();
            }
        },

        /**
         * 设置/更新模拟日期标记线
         * @param {string} dateStr - 'YYYY-MM-DD'
         */
        setMarkerDate(dateStr) {
            if (!this._initialized || !dateStr) return;
            const date = gantt.date.parseDate(dateStr, "%Y-%m-%d");
            gantt.deleteMarker("sim_marker");
            gantt.addMarker({
                id: "sim_marker",
                start_date: date,
                css: "gantt_today_line",
                text: dateStr,
                title: "模拟日期: " + dateStr,
            });
            gantt.render();
        },

        /**
         * Highlight的任务行
         */
        selectTask(id) {
            if (!this._initialized) return;
            try {
                gantt.selectTask(id);
            } catch (e) {}
        },

        /**
         * 滚动到指定任务
         */
        scrollToTask(id) {
            if (!this._initialized) return;
            const node = gantt.getTaskNode(id);
            if (node) node.scrollIntoView({ behavior: "smooth", block: "center" });
        },

        onTaskClick(callback) {
            this._taskClickCallback = callback;
        },

        onTimelineClick(callback) {
            this._timelineClickCallback = callback;
        },

        onTaskUpdate(callback) {
            this._taskUpdateCallback = callback;
        },

        getTask(id) {
            return gantt.getTask(id);
        },

        getAllTasks() {
            return this._tasks;
        },
    };

    window.BIMGantt = BIMGantt;
})();
