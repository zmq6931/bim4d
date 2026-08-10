/**
 * 主控制器
 * 负责：模块协调、API 调用、事件绑定、全局状态
 *
 * 依赖：BIMViewer, BIMGantt, BIMSimulator, BIMLinker
 */

class BIMApp {
    constructor() {
        this.elements = [];          // 全部elements元数据
        this.elementMap = new Map(); // guid -> meta
        this.tasks = [];
        this.links = [];
        this.dateRange = {};
        this.taskToElements = new Map(); // taskId -> Set(guid)
        this.elementToTasks = new Map(); // guid -> Set(taskId)
        this._linkedGuids = new Set();
    }

    // ------------------------------------------------------------------ //
    //  初始化
    // ------------------------------------------------------------------ //
    async init() {
        // 初始化各模块（BIMViewer.init 是异步的，waiting for three.js）
        try {
            await BIMViewer.init(document.getElementById("viewer-container"));
        } catch(e) {
            console.error('BIMViewer init 失败:', e);
            this.toast('3D view init failed: ' + e.message, 'error');
        }
        BIMGantt.init("gantt-container");

        // 先清空 hint，换成 gantt 容器（dhtmlx 需要 div）
        // 已在 HTML 中放好

        this._bindEvents();
        this._bindModules();

        // 检查已有状态（刷新页面后）
        await this._checkStatus();
    }

    _bindEvents() {
        // 导入 IFC
        document.getElementById("btnUploadIfc").onclick = () =>
            document.getElementById("ifcFileInput").click();
        document.getElementById("ifcFileInput").onchange = (e) => {
            if (e.target.files[0]) this.uploadIfc(e.target.files[0]);
        };

        // 导入 XER
        document.getElementById("btnUploadXer").onclick = () =>
            document.getElementById("xerFileInput").click();
        document.getElementById("xerFileInput").onchange = (e) => {
            if (e.target.files[0]) this.uploadXer(e.target.files[0]);
        };

        // Auto Link
        document.getElementById("btnAutoLink").onclick = () =>
            BIMLinker.previewAutoLink();

        // Manual Link
        document.getElementById("btnManualLink").onclick = () =>
            BIMLinker.enterLinkMode();

        document.getElementById("btnApplyAllSuggestions").onclick = () =>
            BIMLinker.applyAllSuggestions();
        document.getElementById("btnCloseSuggestions").onclick = () =>
            BIMLinker.closeSuggestions();

        // Clear Links
        document.getElementById("btnClearLinks").onclick = () =>
            BIMLinker.clearAllLinks();

        // Save / Load Project
        document.getElementById("btnSaveProject").onclick = () => this._saveProject();
        document.getElementById("btnLoadProject").onclick = () => {
            var inp = document.createElement('input');
            inp.type = 'file'; inp.accept = '.bim4d,.json';
            inp.onchange = (e) => { if (e.target.files[0]) this._loadProject(e.target.files[0]); };
            inp.click();
        };

        // Link bar buttons
        document.getElementById("btnFinishLink").onclick = () =>
            BIMLinker.confirmLinks();
        document.getElementById("btnCancelLink").onclick = () =>
            BIMLinker.exitLinkMode();

        // 视图
        document.getElementById("btnFitView").onclick = () =>
            BIMViewer.fitView();

        // Show All
        document.getElementById("btnShowAll").onclick = () => {
            for (const [guid, mesh] of BIMViewer.meshes) mesh.visible = true;
            if (typeof BIMTree !== 'undefined') BIMTree._refreshEyes(true);
            this.toast("All shown", "success");
        };

        // Hide Selected
        document.getElementById("btnHideSelected").onclick = () => {
            const v = BIMViewer;
            const hlCount = v.highlightedGuids ? v.highlightedGuids.size : -1;
            const last = v._lastSelected;
            if (hlCount <= 0 && !last) {
                this.toast("Click an element in 3D view first", "error");
                return;
            }
            const guids = hlCount > 0 ? Array.from(v.highlightedGuids) : [last];
            // clearHighlight 会把 visible 恢复成 true，所以隐藏必须在它之后
            v.clearHighlight();
            for (const g of guids) {
                const m = v.meshes.get(g);
                if (m) m.visible = false;
            }
            v._lastSelected = null;
            if (typeof BIMTree !== 'undefined' && BIMTree._refreshEyes) BIMTree._refreshEyes();
            this.toast(`已隐藏 ${guids.length} 个elements`, "success");
        };

        // Cancel关联：支持从任务角度或elements角度
        document.getElementById("btnUnlinkSelected").onclick = async () => {
            let guidsToUnlink = [];

            // 情况1：甘特图中选了任务 → Cancel该任务的所有关联
            if (this._selectedTaskId) {
                const elems = this.taskToElements.get(this._selectedTaskId);
                if (elems && elems.size > 0) {
                    guidsToUnlink = Array.from(elems);
                }
            }

            // 情况2：3D 中高亮了elements → Cancel这些elements的关联
            if (guidsToUnlink.length === 0 && BIMViewer.highlightedGuids.size > 0) {
                guidsToUnlink = Array.from(BIMViewer.highlightedGuids);
            }

            // 情况3：最近点击过elements
            if (guidsToUnlink.length === 0 && BIMViewer._lastSelected) {
                guidsToUnlink = [BIMViewer._lastSelected];
            }

            if (guidsToUnlink.length === 0) {
                this.toast("Click a task in Gantt or element in 3D first", "error");
                return;
            }

            // 删除关联
            const links = await (await fetch("/api/links")).json();
            let removed = 0;
            for (const l of links) {
                if (guidsToUnlink.includes(l.elementGuid)) {
                    await fetch(`/api/link/${l.id}`, { method: "DELETE" });
                    removed++;
                }
            }

            // 清理本地索引
            for (const g of guidsToUnlink) {
                this.elementToTasks.delete(g);
                this._linkedGuids.delete(g);
            }
            for (const [tid, elems] of this.taskToElements) {
                for (const g of guidsToUnlink) elems.delete(g);
            }

            BIMViewer.clearHighlight();
            this._selectedTaskId = null;
            const ds = BIMSimulator.getCurrentDateStr();
            if (ds) await this._onSimDateChange(ds);
            else BIMViewer.applyStates({}, this._linkedGuids);
            if (typeof BIMTree !== 'undefined' && BIMTree.refreshLinks) BIMTree.refreshLinks();
            document.getElementById("linkStatus").textContent = `关联: ${this._linkedGuids.size}`;
            this.toast(`已Cancel ${removed} links`, "success");
        };

        // Model tree panel
        document.getElementById("btnToggleTree").onclick = () =>
            BIMTree.toggle();
        document.getElementById("btnCloseTree").onclick = () =>
            BIMTree.toggle();
        document.getElementById("btnExpandAll").onclick = () =>
            BIMTree.expandAll();
        document.getElementById("btnCollapseAll").onclick = () =>
            BIMTree.collapseAll();
        document.getElementById("btnShowAll").onclick = () =>
            BIMTree.showAll();
        document.getElementById("btnHideAll").onclick = () =>
            BIMTree.hideAll();

        // 框选模式
        let boxSelectActive = false;
        document.getElementById("btnBoxSelect").onclick = () => {
            boxSelectActive = !boxSelectActive;
            const btn = document.getElementById("btnBoxSelect");
            if (boxSelectActive) {
                BIMViewer.setBoxSelectMode((guids) => {
                    BIMViewer.highlightElements(guids);
                    this.toast(`框选了 ${guids.length} 个elements`, "info");
                    // 如果 linker 在关联模式，批量传递
                    if (typeof BIMLinker !== 'undefined' && BIMLinker._linkMode) {
                        BIMLinker._onElementPicked(guids);
                    }
                });
                btn.classList.add("btn-active-toggle");
                btn.textContent = "⬡ Selecting...";
            } else {
                BIMViewer.setBoxSelectMode(null);
                btn.classList.remove("btn-active-toggle");
                btn.textContent = "⬡ 框选";
            }
        };

        // Colors
        document.getElementById("btnColorSettings").onclick = () =>
            this._toggleColorPanel();

        document.getElementById("btnApplyColors").onclick = () =>
            this._applyColorSettings();

        document.getElementById("btnResetColors").onclick = () =>
            this._resetColorSettings();

        // 时间轴
        document.getElementById("btnPlay").onclick = () => {
            if (BIMSimulator._playing) BIMSimulator.pause();
            else BIMSimulator.play();
        };
        document.getElementById("btnStop").onclick = () => BIMSimulator.stop();
        document.getElementById("btnStepForward").onclick = () =>
            BIMSimulator.stepForward();
        document.getElementById("btnStepBack").onclick = () =>
            BIMSimulator.stepBack();
        document.getElementById("dateSlider").oninput = (e) =>
            BIMSimulator.setDay(parseInt(e.target.value));
        document.getElementById("speedSelect").onchange = (e) =>
            BIMSimulator.setSpeed(parseInt(e.target.value));

        // Sim start date change
        document.getElementById("simStartDate").onchange = (e) => {
            const newStart = e.target.value;
            if (newStart) {
                BIMSimulator.setCustomStart(newStart);
                e.target.value = BIMSimulator.getStartDateStr();  // 回写实际值
                const d = BIMSimulator.getCurrentDateStr();
                if (d) this._onSimDateChange(d);
            }
        };
    }

    _bindModules() {
        // 4D 模拟日期变化 → 更新elements状态
        BIMSimulator.onDateChange((dateStr) => this._onSimDateChange(dateStr));

        // 甘特图默认点击 → 高亮关联elements
        BIMGantt.onTaskClick((taskId, task) =>
            this.onTaskSelected(taskId, task)
        );

        // 任务时间被编辑 → 同步数据并刷新模拟
        BIMGantt.onTaskUpdate((taskId, updated) => {
            const fmt = gantt.date.date_to_str("%Y-%m-%d");
            const s = updated.start_date ? fmt(updated.start_date) : '';
            const f = updated.end_date ? fmt(updated.end_date) : '';
            const t = this.tasks.find(x => x.id === taskId);
            if (t) {
                t.start_date = s;
                t.startDate = s;
                t.finishDate = f;
                t.duration = updated.duration || 1;
            }
            const ds = BIMSimulator.getCurrentDateStr();
            if (ds) this._calculateSimStates(ds);
        });

        // 甘特图时间轴点击 → 跳转模拟日期
        BIMGantt.onTimelineClick((dateStr) => {
            BIMSimulator.setDate(dateStr);
        });

        // 3D 视图点击elements → 显示信息 + 联动甘特图
        BIMViewer.onElementPicked = (guid) => this.onElementSelected(guid);
    }

    // ------------------------------------------------------------------ //
    //  上传
    // ------------------------------------------------------------------ //
    async uploadIfc(file) {
        this.showLoading("Parsing IFC (may be slow first time)...");
        try {
            const formData = new FormData();
            formData.append("file", file);
            const res = await fetch("/api/upload/ifc", { method: "POST", body: formData });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || "Parse failed");

            // 拉取完整elements列表
            const allRes = await fetch("/api/elements");
            this.elements = await allRes.json();
            this.elements.forEach((el) => this.elementMap.set(el.guid, el));

            document.getElementById("ifcStatus").textContent =
                `IFC: ${data.elementCount} elements`;
            document.getElementById("ifcStatus").classList.add("active");
            document.getElementById("viewer-hint").style.display = "none";

            this.toast(data.message, "success");

            // 加载几何
            await BIMViewer.loadAllElements(this.elements, (loaded, total) => {
                this.updateLoading(`加载 3D 模型... ${loaded}/${total}`);
            });

            // 初始全部设为Unlinked状态
            BIMViewer.applyStates({}, new Set());

            // 建Model Tree
            if (typeof BIMTree !== 'undefined') BIMTree.build(this.elements);

            this._updateAutoLinkBtn();
        } catch (e) {
            this.toast("IFC import failed: " + e.message, "error");
        } finally {
            this.hideLoading();
        }
    }

    async uploadXer(file) {
        this.showLoading("Parsing XER...");
        try {
            const formData = new FormData();
            formData.append("file", file);
            const res = await fetch("/api/upload/xer", { method: "POST", body: formData });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || "Parse failed");

            this.tasks = data.tasks;
            this.links = data.links;
            this.dateRange = data.dateRange;

            // 清掉旧 hint
            const container = document.getElementById("gantt-container");
            const hint = container.querySelector(".hint-box");
            if (hint) hint.remove();

            BIMGantt.loadData(this.tasks, this.links, this.dateRange);

            document.getElementById("xerStatus").textContent =
                `XER: ${data.taskCount} 任务`;
            document.getElementById("xerStatus").classList.add("active");

            // 配置时间轴范围
            if (this.dateRange.start && this.dateRange.finish) {
                BIMSimulator.setRange(this.dateRange.start, this.dateRange.finish);
                var si = document.getElementById("simStartDate");
                if (si) si.value = BIMSimulator.getStartDateStr();
            }

            this.toast(data.message, "success");
            this._updateAutoLinkBtn();
        } catch (e) {
            this.toast("XER import failed: " + e.message, "error");
        } finally {
            this.hideLoading();
        }
    }

    // ------------------------------------------------------------------ //
    //  关联刷新
    // ------------------------------------------------------------------ //
    async refreshLinks() {
        try {
            const res = await fetch("/api/links");
            const links = await res.json();

            // 重建索引
            this.taskToElements.clear();
            this.elementToTasks.clear();
            this._linkedGuids.clear();
            for (const l of links) {
                if (!this.taskToElements.has(l.taskId))
                    this.taskToElements.set(l.taskId, new Set());
                this.taskToElements.get(l.taskId).add(l.elementGuid);

                if (!this.elementToTasks.has(l.elementGuid))
                    this.elementToTasks.set(l.elementGuid, new Set());
                this.elementToTasks.get(l.elementGuid).add(l.taskId);

                this._linkedGuids.add(l.elementGuid);
            }

            document.getElementById("linkStatus").textContent =
                `关联: ${links.length}`;
            document.getElementById("linkStatus").classList.add("active");

            // 刷新 3D 视图状态
            const dateStr = BIMSimulator.getCurrentDateStr();
            if (dateStr) this._onSimDateChange(dateStr);
            else BIMViewer.applyStates({}, this._linkedGuids);

            // 刷新树面板关联标记
            if (typeof BIMTree !== 'undefined') BIMTree.refreshLinks();
        } catch (e) {
            console.error("刷新Link failed", e);
        }
    }

    // ------------------------------------------------------------------ //
    //  模拟日期变化 → 本地计算（支持任务时间修改后即时生效）
    // ------------------------------------------------------------------ //
    async _onSimDateChange(dateStr) {
        BIMGantt.setMarkerDate(dateStr);
        this._calculateSimStates(dateStr);
    }

    _calculateSimStates(dateStr) {
        if (this._linkedGuids.size === 0) return;
        const states = {};
        for (const [guid, taskIds] of this.elementToTasks) {
            let state = 'pending';
            for (const tid of taskIds) {
                const task = this.tasks.find(t => t.id === tid);
                if (!task) continue;
                const s = task.startDate || task.start_date || '';
                const f = task.finishDate || '';
                if (!s || !f) continue;
                if (dateStr > f) state = 'done';
                else if (dateStr >= s && dateStr <= f) state = 'active';
                if (state === 'active') break;
            }
            states[guid] = state;
        }
        BIMViewer.applyStates(states, this._linkedGuids);
    }

    // ------------------------------------------------------------------ //
    //  任务选中联动
    // ------------------------------------------------------------------ //
    onTaskSelected(taskId, task) {
        if (task.isWbs) return;
        this._selectedTaskId = taskId;
        BIMGantt.selectTask(taskId);

        const elems = this.taskToElements.get(taskId);
        if (elems && elems.size > 0) {
            BIMViewer.highlightElements(Array.from(elems));
            this.toast(
                `任务"${task.text}" 关联 ${elems.size} 个elements — Click 🔓 to unlink, or ✋ to add more`, "info"
            );
        } else {
            BIMViewer.clearHighlight();
            // 没有关联 → 自动进入Manual Link模式
            this.toast(`任务"${task.text}" 暂无关联 — 请在 3D 视图或Model Tree中选elements`, "info");
            BIMLinker._linkMode = true;
            BIMLinker._selectedTaskId = taskId;
            BIMLinker._selectedElementGuids.clear();
            if (typeof BIMTree !== 'undefined') BIMTree.clearLinkPicks();
            BIMViewer.setPickMode((guid) => BIMLinker._onElementPicked(guid));
            var bar = document.getElementById("link-hint-bar");
            bar.classList.remove("hidden");
            document.getElementById("linkHintText").innerHTML =
                `已选任务：<b>${task.text}</b>，点击elements或框选来添加关联`;
        }
    }

    /**
     * 3D 视图中点击elements → 高亮 + 联动甘特图选中关联任务
     */
    onElementSelected(guid) {
        const meta = this.elementMap.get(guid);
        if (!meta) return;
        // 找到该elements关联的任务
        const taskIds = this.elementToTasks.get(guid);
        if (taskIds && taskIds.size > 0) {
            const tid = Array.from(taskIds)[0];
            const task = this.tasks.find((t) => t.id === tid);
            if (task) {
                BIMGantt.selectTask(tid);
                BIMGantt.scrollToTask(tid);
                this.toast(
                    `elements"${meta.name || meta.type}" → 任务"${task.taskName || task.text}"`,
                    "info"
                );
                return;
            }
        }
        this.toast(
            `elements: ${meta.name || meta.type} (${meta.floor || "未分层"}) - Unlinked任务`,
            "info"
        );
    }

    // ------------------------------------------------------------------ //
    //  辅助
    // ------------------------------------------------------------------ //
    _updateAutoLinkBtn() {
        const ready = this.elements.length > 0 && this.tasks.length > 0;
        document.getElementById("btnAutoLink").disabled = !ready;
        document.getElementById("btnManualLink").disabled = !ready;
        document.getElementById("btnClearLinks").disabled = this._linkedGuids.size === 0;
        document.getElementById("btnSaveProject").disabled = !ready;
    }

    async _checkStatus() {
        try {
            const res = await fetch("/api/status");
            const data = await res.json();
            if (data.ifcLoaded) {
                const allRes = await fetch("/api/elements");
                this.elements = await allRes.json();
                this.elements.forEach((el) => this.elementMap.set(el.guid, el));
                document.getElementById("ifcStatus").textContent =
                    `IFC: ${this.elements.length} elements`;
                document.getElementById("ifcStatus").classList.add("active");
                document.getElementById("viewer-hint").style.display = "none";
                await BIMViewer.loadAllElements(this.elements, (loaded, total) => {
                    this.updateLoading(`加载 3D 模型... ${loaded}/${total}`);
                });
                BIMViewer.applyStates({}, new Set());
                // 建Model Tree
                if (typeof BIMTree !== 'undefined') BIMTree.build(this.elements);
            }
            if (data.xerLoaded) {
                const tRes = await fetch("/api/tasks");
                const tData = await tRes.json();
                this.tasks = tData.tasks;
                this.links = tData.links;
                this.dateRange = tData.dateRange;
                const container = document.getElementById("gantt-container");
                const hint = container.querySelector(".hint-box");
                if (hint) hint.remove();
                BIMGantt.loadData(this.tasks, this.links, this.dateRange);
                document.getElementById("xerStatus").textContent =
                    `XER: ${this.tasks.length} 任务`;
                document.getElementById("xerStatus").classList.add("active");
                if (this.dateRange.start && this.dateRange.finish) {
                    BIMSimulator.setRange(this.dateRange.start, this.dateRange.finish);
                    var si2 = document.getElementById("simStartDate");
                    if (si2) si2.value = BIMSimulator.getStartDateStr();
                }
            }
            if (data.linkCount > 0) {
                await this.refreshLinks();
            }
            this._updateAutoLinkBtn();
        } catch (e) {
            // 后端未启动时静默
        }
    }

    // ------------------------------------------------------------------ //
    //  UI 辅助
    // ------------------------------------------------------------------ //
    toast(msg, type = "info") {
        const t = document.getElementById("toast");
        t.textContent = msg;
        t.className = "toast " + type;
        setTimeout(() => t.classList.add("hidden"), 3500);
    }

    showLoading(text = "Processing...") {
        document.getElementById("loadingText").textContent = text;
        document.getElementById("loading-overlay").classList.remove("hidden");
    }

    updateLoading(text) {
        document.getElementById("loadingText").textContent = text;
    }

    hideLoading() {
        document.getElementById("loading-overlay").classList.add("hidden");
    }

    // ------------------------------------------------------------------ //
    //  Colors面板
    // ------------------------------------------------------------------ //
    _toggleColorPanel() {
        const panel = document.getElementById("color-panel");
        const isHidden = panel.classList.contains("hidden");
        if (isHidden) {
            this._buildColorPanel();
            panel.classList.remove("hidden");
        } else {
            panel.classList.add("hidden");
        }
    }

    _buildColorPanel() {
        const rowsEl = document.getElementById("color-rows");
        const colors = BIMViewer.getStateColors();
        rowsEl.innerHTML = '';
        for (const [state, info] of Object.entries(colors)) {
            const row = document.createElement('div');
            row.className = 'color-row';
            row.innerHTML = `
                <label>${info.label}</label>
                <input type="color" value="${info.color}" data-state="${state}" data-field="color">
                <input type="range" min="0" max="1" step="0.05" value="${info.opacity}" data-state="${state}" data-field="opacity">
                <span class="opacity-val">${Math.round(info.opacity * 100)}%</span>
            `;
            // 实时预览：拖动滑块时更新 opacity 数字
            const range = row.querySelector('input[type="range"]');
            const valSpan = row.querySelector('.opacity-val');
            range.oninput = () => {
                valSpan.textContent = Math.round(range.value * 100) + '%';
            };
            rowsEl.appendChild(row);
        }
    }

    _applyColorSettings() {
        const panel = document.getElementById("color-panel");
        const inputs = panel.querySelectorAll('input[data-state]');
        const colors = {};
        for (const input of inputs) {
            const state = input.dataset.state;
            const field = input.dataset.field;
            if (!colors[state]) colors[state] = {};
            if (field === 'color') colors[state].color = input.value.replace('#', '');
            if (field === 'opacity') colors[state].opacity = input.value;
        }
        BIMViewer.setStateColors(colors);
        panel.classList.add("hidden");
        this.toast("Colors applied", "success");
    }

    _resetColorSettings() {
        const defaults = {
            done:      { color: '4caf50', opacity: 1.0 },
            active:    { color: 'ffc107', opacity: 0.75 },
            pending:   { color: '666666', opacity: 0 },
            unlinked:  { color: '888888', opacity: 0.35 },
            highlight: { color: '4a9eff', opacity: 1.0 },
        };
        BIMViewer.setStateColors(defaults);
        document.getElementById("color-panel").classList.add("hidden");
        this.toast("Colors reset", "success");
    }

    // ------------------------------------------------------------------ //
    //  项目保存 / 加载
    // ------------------------------------------------------------------ //
    _saveProject() {
        if (this.elements.length === 0 && this.tasks.length === 0) {
            this.toast("Nothing to save — import IFC/XER first", "error");
            return;
        }
        const data = {
            version: 1,
            savedAt: new Date().toISOString(),
            elements: this.elements.map(e => ({ guid: e.guid, name: e.name, type: e.type, floor: e.floor })),
            tasks: this.tasks,
            elemLinks: [],      // element-task links
            ganttLinks: [],     // task dependency lines in Gantt
            colors: BIMViewer.getStateColors(),
            dateRange: this.dateRange,
        };
        // Get current element-task links + gantt dependency links
        fetch("/api/links").then(r => r.json()).then(elemLinks => {
            data.elemLinks = elemLinks;
            try { data.ganttLinks = gantt.getLinks(); } catch(e) {}
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'bim4d_project_' + new Date().toISOString().slice(0,10) + '.bim4d';
            a.click(); URL.revokeObjectURL(url);
            this.toast("Project saved", "success");
        }).catch(() => this.toast("Failed to fetch links for save", "error"));
    }

    async _loadProject(file) {
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!data.version) throw new Error("Invalid project file");

            // Restore tasks
            if (data.tasks && data.tasks.length > 0) {
                this.tasks = data.tasks;
                this.dateRange = data.dateRange || {};
                const container = document.getElementById("gantt-container");
                const hint = container.querySelector(".hint-box");
                if (hint) hint.remove();
                // Restore gantt dependency lines
                const glinks = data.ganttLinks || [];
                BIMGantt.loadData(this.tasks, glinks, this.dateRange);
                document.getElementById("xerStatus").textContent = `XER: ${this.tasks.length} tasks`;
                document.getElementById("xerStatus").classList.add("active");
                if (this.dateRange.start && this.dateRange.finish) {
                    BIMSimulator.setRange(this.dateRange.start, this.dateRange.finish);
                    var si = document.getElementById("simStartDate");
                    if (si) si.value = BIMSimulator.getStartDateStr();
                }
            }

            // Restore element-task links
            if (data.elemLinks && data.elemLinks.length > 0) {
                await fetch("/api/link/batch", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ links: data.elemLinks.map(l => ({ taskId: l.taskId, elementGuid: l.elementGuid })) })
                });
                await this.refreshLinks();
            }

            // Restore colors
            if (data.colors) {
                const colors = {};
                for (const [k, v] of Object.entries(data.colors)) {
                    colors[k] = { color: v.color.replace('#', ''), opacity: v.opacity };
                }
                BIMViewer.setStateColors(colors);
            }

            this._updateAutoLinkBtn();
            this.toast("Project loaded — re-import IFC if model not visible", "success");
        } catch (e) {
            this.toast("Failed to load project: " + e.message, "error");
        }
    }
}

// Start
window.BIMApp = new BIMApp();
window.BIMApp.init();
