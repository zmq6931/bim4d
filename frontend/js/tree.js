/**
 * Model tree panel
 * 负责：按类型归类elements、展开折叠、显隐切换
 *
 * 暴露到 window.BIMTree
 * 依赖：window.BIMViewer, window.BIMApp
 */
(function () {
    "use strict";

    const BIMTree = {
        _elements: [],
        _typeIcons: { Wall: '🧱', Slab: '🟫', Column: '🏛️', Beam: '〰️',
                      Door: '🚪', Window: '🪟', Roof: '🏠', Stair: '🪜',
                      Railing: '↗️', Footing: '⬜', CurtainWall: '🪟',
                      Covering: '📐', Member: '📏', Plate: '▬',
                      FlowSegment: '🔧', FlowFitting: '🔩',
                      DuctSegment: '🔲', PipeSegment: '⭕',
                      Space: '📦', Ramp: '📐' },

        /** 从 elements 数据构建树 */
        build(elements) {
            this._elements = elements;
            const tree = document.getElementById('model-tree');
            if (!tree) return;

            // 按类型分组
            const groups = {};
            for (const el of elements) {
                if (!groups[el.type]) groups[el.type] = [];
                groups[el.type].push(el);
            }

            // 按名称排序类型
            const sortedTypes = Object.keys(groups).sort();

            if (sortedTypes.length === 0) {
                tree.innerHTML = '<div class="tree-empty">暂无elements</div>';
                return;
            }

            tree.innerHTML = '';
            sortedTypes.forEach((type, idx) => {
                const items = groups[type];
                const icon = this._typeIcons[type] || '📦';
                const catDiv = document.createElement('div');
                catDiv.className = 'tree-category';
                catDiv.innerHTML = `
                    <div class="tree-cat-header" data-type="${type}">
                        <span class="tree-cat-arrow">▶</span>
                        <span class="tree-cat-icon">${icon}</span>
                        <span class="tree-cat-name">${type}</span>
                        <span class="tree-cat-count">${items.length}</span>
                        <span class="tree-cat-eye" data-type="${type}" title="显示/隐藏">👁</span>
                    </div>
                    <div class="tree-children" data-type="${type}"></div>
                `;
                // 子项列表
                const childrenDiv = catDiv.querySelector('.tree-children');
                items.forEach(el => {
                    const name = el.name || el.guid.slice(0, 12);
                    const itemDiv = document.createElement('div');
                    itemDiv.className = 'tree-item';
                    itemDiv.setAttribute('data-guid', el.guid);
                    // 已关联的加标记
                    const linked = BIMApp._linkedGuids && BIMApp._linkedGuids.has(el.guid);
                    itemDiv.innerHTML = `
                        <span class="tree-item-name">${this._escape(name)}</span>
                        ${linked ? '<span style="color:var(--accent);font-size:10px;">🔗</span>' : ''}
                        <span class="tree-item-eye" data-guid="${el.guid}" title="显示/隐藏">👁</span>
                    `;
                    childrenDiv.appendChild(itemDiv);
                });

                tree.appendChild(catDiv);
            });

            this._bindEvents(tree);
        },

        _expandCategory(catDiv, expand) {
            const arrow = catDiv.querySelector('.tree-cat-arrow');
            const children = catDiv.querySelector('.tree-children');
            if (expand) {
                arrow.classList.add('expanded');
                children.classList.add('expanded');
            } else {
                arrow.classList.remove('expanded');
                children.classList.remove('expanded');
            }
        },

        _bindEvents(tree) {
            // 分类箭头 → 展开/折叠
            tree.querySelectorAll('.tree-cat-arrow').forEach(arrow => {
                arrow.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const catDiv = arrow.closest('.tree-category');
                    const expanded = arrow.classList.contains('expanded');
                    this._expandCategory(catDiv, !expanded);
                });
            });

            // 分类头其他区域 → 全选/Cancel该分类下所有elements
            tree.querySelectorAll('.tree-cat-header').forEach(header => {
                header.addEventListener('click', (e) => {
                    // 忽略箭头、eye 按钮的点击
                    if (e.target.classList.contains('tree-cat-arrow') ||
                        e.target.classList.contains('tree-cat-eye')) return;
                    const type = header.getAttribute('data-type');
                    this._selectCategory(type);
                });
            });

            // 分类眼睛 → 显示/隐藏整类
            tree.querySelectorAll('.tree-cat-eye').forEach(eye => {
                eye.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const type = eye.getAttribute('data-type');
                    const hidden = eye.classList.contains('hidden-state');
                    this._toggleType(type, hidden);
                    eye.classList.toggle('hidden-state', !hidden);
                    eye.textContent = hidden ? '👁' : '—';
                });
            });

            // 单项眼睛 → 显示/隐藏单个elements
            tree.querySelectorAll('.tree-item-eye').forEach(eye => {
                eye.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const guid = eye.getAttribute('data-guid');
                    const mesh = BIMViewer.meshes.get(guid);
                    if (mesh) {
                        const hidden = eye.classList.contains('hidden-state');
                        mesh.visible = !hidden;
                        eye.classList.toggle('hidden-state', !hidden);
                        eye.textContent = hidden ? '👁' : '—';
                    }
                });
            });

            // 单项点击 → 高亮 + 联动甘特图 / 关联模式选中
            tree.querySelectorAll('.tree-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    const guid = item.getAttribute('data-guid');

                    // 判断是否在关联模式
                    if (typeof BIMLinker !== 'undefined' && BIMLinker._linkMode) {
                        // 关联模式：切换选中状态（多选）
                        const isPick = item.classList.contains('link-pick');
                        if (isPick) {
                            item.classList.remove('link-pick');
                        } else {
                            item.classList.add('link-pick');
                        }
                        // 通知 linker
                        BIMLinker._onElementPicked(guid);
                        // 刷新 3D 高亮
                        const allPicked = Array.from(tree.querySelectorAll('.tree-item.link-pick')).map(el => el.getAttribute('data-guid'));
                        BIMViewer.highlightElements(allPicked);
                        return;
                    }

                    // 普通模式：单选高亮
                    tree.querySelectorAll('.tree-item.selected').forEach(i => i.classList.remove('selected'));
                    item.classList.add('selected');
                    BIMViewer.highlightElements([guid]);
                    if (BIMApp.onElementSelected) BIMApp.onElementSelected(guid);
                });
            });
        },

        /** 切换整个类型的显示/隐藏 */
        _toggleType(type, show) {
            const elements = this._elements.filter(el => el.type === type);
            elements.forEach(el => {
                const mesh = BIMViewer.meshes.get(el.guid);
                if (mesh) mesh.visible = show;
            });

            // 更新子项眼睛图标
            const tree = document.getElementById('model-tree');
            if (!tree) return;
            tree.querySelectorAll(`.tree-item-eye[data-guid]`).forEach(eye => {
                const guid = eye.getAttribute('data-guid');
                const el = this._elements.find(e => e.guid === guid);
                if (el && el.type === type) {
                    eye.classList.toggle('hidden-state', !show);
                    eye.textContent = show ? '👁' : '—';
                }
            });
        },

        /** Show All */
        showAll() {
            for (const [guid, mesh] of BIMViewer.meshes) {
                mesh.visible = true;
            }
            this._refreshEyes(true);
        },

        /** Hide All */
        hideAll() {
            for (const [guid, mesh] of BIMViewer.meshes) {
                mesh.visible = false;
            }
            this._refreshEyes(false);
        },

        /** Expand All */
        expandAll() {
            const tree = document.getElementById('model-tree');
            if (!tree) return;
            tree.querySelectorAll('.tree-category').forEach(cat => this._expandCategory(cat, true));
        },

        /** Collapse All */
        collapseAll() {
            const tree = document.getElementById('model-tree');
            if (!tree) return;
            tree.querySelectorAll('.tree-category').forEach(cat => this._expandCategory(cat, false));
        },

        _refreshEyes(visible) {
            const tree = document.getElementById('model-tree');
            if (!tree) return;
            if (visible !== undefined) {
                // 全部设成同一状态
                tree.querySelectorAll('.tree-cat-eye').forEach(e => {
                    e.classList.toggle('hidden-state', !visible);
                    e.textContent = visible ? '👁' : '—';
                });
                tree.querySelectorAll('.tree-item-eye').forEach(e => {
                    e.classList.toggle('hidden-state', !visible);
                    e.textContent = visible ? '👁' : '—';
                });
            } else {
                // 逐个检查 mesh 实际可见性
                tree.querySelectorAll('.tree-item-eye').forEach(e => {
                    const guid = e.getAttribute('data-guid');
                    const mesh = BIMViewer.meshes.get(guid);
                    const vis = mesh ? mesh.visible : true;
                    e.classList.toggle('hidden-state', !vis);
                    e.textContent = vis ? '👁' : '—';
                });
                // 分类 eye：如果该分类下所有elements都隐藏，则标记为 hidden
                tree.querySelectorAll('.tree-cat-eye').forEach(eye => {
                    const type = eye.getAttribute('data-type');
                    const items = tree.querySelectorAll(`.tree-item[data-guid]`);
                    let allHidden = true;
                    items.forEach(item => {
                        const el = this._elements.find(e => e.guid === item.getAttribute('data-guid'));
                        if (el && el.type === type) {
                            const mesh = BIMViewer.meshes.get(item.getAttribute('data-guid'));
                            if (mesh && mesh.visible) allHidden = false;
                        }
                    });
                    eye.classList.toggle('hidden-state', allHidden);
                    eye.textContent = allHidden ? '—' : '👁';
                });
            }
        },

        /** 切换面板显示 */
        toggle() {
            const panel = document.getElementById('model-tree-panel');
            panel.classList.toggle('hidden');
        },

        /** 刷新关联标记 */
        refreshLinks() {
            const tree = document.getElementById('model-tree');
            if (!tree) return;
            tree.querySelectorAll('.tree-item').forEach(item => {
                const guid = item.getAttribute('data-guid');
                const hasLink = BIMApp._linkedGuids && BIMApp._linkedGuids.has(guid);
                const existing = item.querySelector('[style]');
                if (existing && !hasLink) existing.remove();
                if (!existing && hasLink) {
                    const span = document.createElement('span');
                    span.style.cssText = 'color:var(--accent);font-size:10px;';
                    span.textContent = '🔗';
                    item.insertBefore(span, item.querySelector('.tree-item-eye'));
                }
            });
        },

        /** Clear Links模式的选中标记 */
        clearLinkPicks() {
            const tree = document.getElementById('model-tree');
            if (!tree) return;
            tree.querySelectorAll('.tree-item.link-pick').forEach(el => el.classList.remove('link-pick'));
        },

        /** 全选/Cancel分类下所有elements（关联模式多选，普通模式3D高亮） */
        _selectCategory(type) {
            const tree = document.getElementById('model-tree');
            if (!tree) return;
            const items = tree.querySelectorAll(`.tree-item[data-guid]`);
            const guids = [];
            items.forEach(item => {
                const el = this._elements.find(e => e.guid === item.getAttribute('data-guid'));
                if (el && el.type === type) guids.push(el.guid);
            });
            if (guids.length === 0) return;

            // 判断是否在关联模式
            if (typeof BIMLinker !== 'undefined' && BIMLinker._linkMode) {
                // 关联模式：全部加入选中
                items.forEach(item => {
                    const el = this._elements.find(e => e.guid === item.getAttribute('data-guid'));
                    if (el && el.type === type) {
                        item.classList.add('link-pick');
                        BIMLinker._onElementPicked(el.guid);
                    }
                });
                // 刷新3D高亮
                const allPicked = Array.from(tree.querySelectorAll('.tree-item.link-pick')).map(el => el.getAttribute('data-guid'));
                BIMViewer.highlightElements(allPicked);
            } else {
                // 普通模式：3D高亮整类
                BIMViewer.highlightElements(guids);
            }
        },

        _escape(s) {
            return String(s || '').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        },
    };

    window.BIMTree = BIMTree;
})();
