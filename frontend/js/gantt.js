/**
 * dhtmlxGantt 甘特图封装
 * 负责：渲染任务树+依赖、选中任务联动、模拟日期标记线
 *
 * 暴露到 window.BIMGantt
 */
(function () {
    "use strict";

    function escapeHtml(str) {
        return String(str == null ? "" : str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    const BIMGantt = {
        _initialized: false,
        _tasks: [],
        _taskClickCallback: null,
        _timelineClickCallback: null,
        _taskUpdateCallback: null,
        _zoomChangeCallback: null,

        init(containerId) {
            if (this._initialized) return;
            this._container = document.getElementById(containerId);

            gantt.config.date_format = "%Y-%m-%d";
            gantt.config.row_height = 28;
            gantt.config.bar_height = 20;
            // 任务列表宽度：优先使用上次拖动分隔条后保存的值
            let savedGridWidth = 400;
            try {
                const saved = parseInt(localStorage.getItem("bim4d_gantt_grid_width") || "", 10);
                if (saved >= 200 && saved <= 1600) savedGridWidth = saved;
            } catch (e) { /* localStorage 不可用时忽略 */ }
            gantt.config.grid_width = savedGridWidth;
            this._savedGridWidth = savedGridWidth;
            gantt.config.autosize = false;
            gantt.config.fit_tasks = true;
            gantt.config.show_progress = true;
            gantt.config.drag_move = false;
            gantt.config.drag_progress = false;
            gantt.config.drag_resize = false;
            gantt.config.drag_links = true;
            gantt.config.smart_rendering = true;
            gantt.config.smart_scales = true;
            gantt.config.order_branch = true;
            gantt.config.grid_resize = true;         // 允许拖拽调整列宽

            // 列定义
            gantt.config.columns = [
                {
                    name: "text", label: "Task", tree: true, width: 280,
                    resize: true, min_width: 120, max_width: 900,
                    // title 提示完整任务名：名称过长时鼠标悬停即可查看
                    template: (t) => {
                        const label = t.text || "";
                        return `<span class="gantt-task-name" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`;
                    },
                },
                {
                    name: "startDate", label: "Start", align: "center",
                    width: 60, template: (t) => t.startDate || "—",
                },
                {
                    name: "finishDate", label: "Finish", align: "center",
                    width: 60, template: (t) => t.finishDate || "—",
                },
            ];

            // Date scales — default to month/day
            gantt.config.scales = [
                { unit: "month", step: 1, format: "%M, %Y" },
                { unit: "day", step: 1, format: "%j" },
            ];
            gantt.config.min_column_width = 28;

            // Zoom levels (day / week / month / year)
            gantt.plugins({
                marker: true,
                zoom: true,
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

            // Zoom levels: Day / Week / Month / Year
            const zoomConfig = {
                levels: [
                    {
                        name: "Day",
                        scale_height: 54,
                        min_column_width: 30,
                        scales: [
                            { unit: "month", step: 1, format: "%M, %Y" },
                            { unit: "day", step: 1, format: "%j" },
                        ],
                    },
                    {
                        name: "Week",
                        scale_height: 54,
                        min_column_width: 60,
                        scales: [
                            { unit: "month", step: 1, format: "%M, %Y" },
                            { unit: "week", step: 1, format: weekScaleFormatter },
                        ],
                    },
                    {
                        name: "Month",
                        scale_height: 54,
                        min_column_width: 80,
                        scales: [
                            { unit: "year", step: 1, format: "%Y" },
                            { unit: "month", step: 1, format: "%M" },
                        ],
                    },
                    {
                        name: "Year",
                        scale_height: 54,
                        min_column_width: 120,
                        scales: [
                            { unit: "year", step: 1, format: "%Y" },
                            { unit: "quarter", step: 1, format: quarterFormatter },
                        ],
                    },
                ],
            };
            function weekScaleFormatter(date) {
                const end = gantt.date.add(date, 6, "day");
                return gantt.date.date_to_str("%M %j")(date) + " - " + gantt.date.date_to_str("%j")(end);
            }
            function quarterFormatter(date) {
                const m = date.getMonth();
                return "Q" + (Math.floor(m / 3) + 1) + " " + date.getFullYear();
            }
            // 注意：ext.zoom.init() 没有返回值，必须直接引用 gantt.ext.zoom
            gantt.ext.zoom.init(zoomConfig);
            this._zoom = gantt.ext.zoom;

            // 任务列表与时间轴之间的可拖动分隔条
            // （此版本的 dhtmlxGantt 未包含 resizer 视图，需自建）
            this._createGridSplitter();

            this._initialized = true;
        },

        /**
         * 自建任务列表/时间轴分隔条：
         * 拖动可调整 gantt.config.grid_width（任务列表宽度），并持久化到 localStorage
         */
        _createGridSplitter() {
            const container = this._container;
            if (!container) return;

            const handle = document.createElement("div");
            handle.className = "gantt_split_resizer";
            handle.title = "拖动调整任务列表宽度";
            container.appendChild(handle);

            const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
            // 宽度不能超过容器的 80%，否则时间轴会被完全挤出
            const clampWidth = (w) => {
                const maxW = Math.max(300, Math.round((container.clientWidth || 1) * 0.8));
                return clamp(w, 240, maxW);
            };
            const updatePosition = () => {
                const left = clampWidth(gantt.config.grid_width || 0);
                handle.style.left = (left - 4) + "px"; // 8px 宽的把手，居中骑在分界线上
                return left;
            };
            updatePosition();

            let dragging = false;
            // dhtmlxGantt 在第一次布局 resize 时会把 grid_width 重置为列宽总和，
            // 这里在首几次渲染中把保存的宽度恢复回来
            let restoreTries = 2;
            gantt.attachEvent("onGanttRender", () => {
                if (restoreTries > 0 && !dragging && this._savedGridWidth) {
                    const w = clampWidth(this._savedGridWidth);
                    if (Math.abs(gantt.config.grid_width - w) > 1) {
                        gantt.config.grid_width = w;
                        gantt.render();
                        restoreTries--;
                    } else {
                        restoreTries = 0;
                    }
                }
                updatePosition();
            });
            window.addEventListener("resize", updatePosition);
            if (typeof ResizeObserver === "function") {
                new ResizeObserver(updatePosition).observe(container);
            }

            let pendingRaf = 0;
            let latestW = 0;
            handle.addEventListener("mousedown", (e) => {
                e.preventDefault();
                dragging = true;
                handle.classList.add("dragging");
            });
            document.addEventListener("mousemove", (e) => {
                if (!dragging) return;
                const rect = container.getBoundingClientRect();
                latestW = clampWidth(e.clientX - rect.left);
                if (Math.abs(latestW - gantt.config.grid_width) < 1) return;
                if (pendingRaf) return;
                pendingRaf = requestAnimationFrame(() => {
                    pendingRaf = 0;
                    gantt.config.grid_width = latestW;
                    gantt.render();
                    updatePosition();
                });
            });
            document.addEventListener("mouseup", () => {
                if (!dragging) return;
                dragging = false;
                handle.classList.remove("dragging");
                try {
                    localStorage.setItem("bim4d_gantt_grid_width", String(Math.round(gantt.config.grid_width)));
                } catch (e) { /* ignore */ }
            });
        },

        /** Switch zoom level: 'Day' | 'Week' | 'Month' | 'Year' */
        setZoomLevel(name) {
            if (!this._zoom) return;
            const levels = this._zoom.getLevels() || [];
            const exists = levels.some((l) => l && l.name === name);
            if (!exists) return;
            this._zoom.setLevel(name);
            if (this._zoomChangeCallback) this._zoomChangeCallback(name);
        },

        /** 当前缩放级别名（'Day' | 'Week' | 'Month' | 'Year'） */
        getZoomLevel() {
            if (!this._zoom) return null;
            const levels = this._zoom.getLevels() || [];
            const idx = this._zoom.getCurrentLevel();
            return levels[idx] ? levels[idx].name : null;
        },

        /** Load task data */
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

        onZoomChange(callback) {
            this._zoomChangeCallback = callback;
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
