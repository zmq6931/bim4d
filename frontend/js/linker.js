/**
 * 关联编辑器
 * 负责：Manual Link（选任务→选elements→确认）、Auto Link建议展示、关联清除
 *
 * 暴露到 window.BIMLinker
 * 依赖：window.BIMViewer, window.BIMGantt, window.BIMApp
 */
(function () {
    "use strict";

    const BIMLinker = {
        _linkMode: false,
        _selectedTaskId: null,
        _selectedElementGuids: new Set(),
        _suggestions: [],

        /**
         * 进入关联模式：监听任务选择
         */
        enterLinkMode() {
            this._linkMode = true;
            this._selectedTaskId = null;
            this._selectedElementGuids.clear();
            if (typeof BIMTree !== 'undefined') BIMTree.clearLinkPicks();

            document.getElementById("link-hint-bar").classList.remove("hidden");
            document.getElementById("linkHintText").textContent =
                "Link mode: select a task in the Gantt chart";

            // 甘特图点击 → 选任务
            BIMGantt.onTaskClick((taskId, task) => {
                if (task.isWbs) return;
                this._selectedTaskId = taskId;
                document.getElementById("linkHintText").innerHTML =
                    `已选任务：<b>${task.text}</b>，请在 3D 视图中点选elements`;
                // 进入elements拾取
                BIMViewer.setPickMode((guid) => this._onElementPicked(guid));
            });
        },

        _onElementPicked(guid) {
            // 支持批量（框选传入数组）
            const guids = Array.isArray(guid) ? guid : [guid];
            for (const g of guids) {
                if (this._selectedElementGuids.has(g)) {
                    this._selectedElementGuids.delete(g);
                } else {
                    this._selectedElementGuids.add(g);
                }
            }

            // 高亮当前选中的elements
            BIMViewer.highlightElements(Array.from(this._selectedElementGuids));

            const hint = document.getElementById("linkHintText");
            if (this._selectedElementGuids.size > 0) {
                hint.innerHTML =
                    `已选 <b>${this._selectedElementGuids.size}</b> 个elements，` +
                    `点击"Confirm"完成`;
            } else {
                hint.innerHTML =
                    `已选任务，请在 3D 视图中点选elements`;
            }
        },

        /**
         * Confirm：提交到后端
         */
        async confirmLinks() {
            if (!this._selectedTaskId || this._selectedElementGuids.size === 0) {
                window.BIMApp.toast("请先选择任务和elements", "error");
                return;
            }

            const pairs = Array.from(this._selectedElementGuids).map((guid) => ({
                taskId: this._selectedTaskId,
                elementGuid: guid,
            }));

            try {
                const res = await fetch("/api/link/batch", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ links: pairs }),
                });
                const data = await res.json();
                window.BIMApp.toast(
                    `Linked ${data.created} 个elements到任务`, "success"
                );
                this.exitLinkMode();
                await window.BIMApp.refreshLinks();
            } catch (e) {
                window.BIMApp.toast("Link failed: " + e.message, "error");
            }
        },

        /**
         * 退出关联模式
         */
        exitLinkMode() {
            this._linkMode = false;
            this._selectedTaskId = null;
            this._selectedElementGuids.clear();
            BIMViewer.setPickMode(null);
            BIMViewer.clearHighlight();
            document.getElementById("link-hint-bar").classList.add("hidden");
            // 清除树面板的选中标记
            if (typeof BIMTree !== 'undefined') BIMTree.clearLinkPicks();
            // 恢复甘特图点击为正常联动
            BIMGantt.onTaskClick((taskId, task) =>
                window.BIMApp.onTaskSelected(taskId, task)
            );
        },

        /**
         * 获取Auto Link建议（预览）
         */
        async previewAutoLink() {
            try {
                const res = await fetch("/api/auto-link", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ apply: false }),
                });
                const data = await res.json();
                this._suggestions = data.suggestions || [];
                this._renderSuggestions();
            } catch (e) {
                window.BIMApp.toast("Auto-link analysis failed: " + e.message, "error");
            }
        },

        _renderSuggestions() {
            const panel = document.getElementById("auto-link-panel");
            const list = document.getElementById("suggestion-list");
            const countEl = document.getElementById("suggestionCount");

            if (this._suggestions.length === 0) {
                window.BIMApp.toast(
                    "No matches found. Check if task names contain type keywords (Wall/Slab/Column etc.)",
                    "error"
                );
                return;
            }

            countEl.textContent = this._suggestions.length;
            panel.classList.remove("hidden");

            list.innerHTML = this._suggestions.map((s, i) => `
                <div class="suggestion-item">
                    <div>
                        <span style="color:var(--accent);">${s.taskName}</span>
                        <span style="color:var(--text-dim); margin: 0 8px;">→</span>
                        <span>${s.elementName || s.elementGuid.slice(0, 12)}</span>
                        <span class="status-pill" style="margin-left:8px;">
                            ${s.elementType}${s.elementFloor ? " / " + s.elementFloor : ""}
                        </span>
                    </div>
                </div>
            `).join("");
        },

        /**
         * Apply全部建议
         */
        async applyAllSuggestions() {
            if (this._suggestions.length === 0) return;

            const pairs = this._suggestions.map((s) => ({
                taskId: s.taskId,
                elementGuid: s.elementGuid,
            }));

            try {
                const res = await fetch("/api/link/batch", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ links: pairs }),
                });
                const data = await res.json();
                window.BIMApp.toast(
                    `Applied ${data.created} links建议`, "success"
                );
                document.getElementById("auto-link-panel").classList.add("hidden");
                this._suggestions = [];
                await window.BIMApp.refreshLinks();
            } catch (e) {
                window.BIMApp.toast("Apply失败: " + e.message, "error");
            }
        },

        closeSuggestions() {
            document.getElementById("auto-link-panel").classList.add("hidden");
        },

        /**
         * 清除全部关联
         */
        async clearAllLinks() {
            if (!confirm("确定清除全部任务-elements关联吗？此操作不可撤销。")) return;
            const links = await (await fetch("/api/links")).json();
            for (const link of links) {
                await fetch(`/api/link/${link.id}`, { method: "DELETE" });
            }
            window.BIMApp.toast(`已清除 ${links.length} links`, "success");
            await window.BIMApp.refreshLinks();
        },
    };

    window.BIMLinker = BIMLinker;
})();
