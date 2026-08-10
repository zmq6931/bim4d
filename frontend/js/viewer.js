/**
 * Three.js 3D 查看器
 * 负责：场景初始化、加载 IFC 构件几何、状态着色/显隐、拾取高亮
 *
 * 暴露到 window.BIMViewer 供其他模块调用
 * three.js 通过 dynamic import 异步加载（避免 module 依赖链问题）
 */

// 动态导入 three.js 和 OrbitControls
let THREE = null;
let OrbitControls = null;
const _ready = (async () => {
    try {
        THREE = await import('three');
        const mod = await import('three/addons/controls/OrbitControls.js');
        OrbitControls = mod.OrbitControls;
    } catch (e) {
        console.error('Three.js 导入失败:', e);
    }
})();

// 状态颜色（可运行时修改）
const STATE_COLORS = {
    done:      { color: 0x4caf50, opacity: 1.0,   visible: true,  transparent: false, label: '已完成' },
    active:    { color: 0xffc107, opacity: 0.75,  visible: true,  transparent: true,  label: '施工中' },
    pending:   { color: 0x666666, opacity: 0,     visible: false, transparent: true,  label: '未开始' },
    unlinked:  { color: 0x888888, opacity: 0.35,  visible: true,  transparent: true,  label: '未关联' },
    highlight: { color: 0x4a9eff, opacity: 1.0,   visible: true,  transparent: false, label: '高亮选中' },
};

// 独立的动画帧函数，直接引用 window.BIMViewer（避免 this 绑定问题）
function _animateFrame() {
    try {
        const self = window.BIMViewer;
        if (self && self.renderer && self.scene && self.camera) {
            // 平滑移动旋转中心到点击位置（仅在非平移状态）
            if (self.controls && self._pivotTarget) {
                self.controls.target.lerp(self._pivotTarget, 0.15);
            }

            // 高亮闪烁（脉动透明度 + 自发光）
            if (self.highlightedGuids.size > 0) {
                const t = Date.now() / 300;
                const pulse = (Math.sin(t) + 1) / 2;
                for (const guid of self.highlightedGuids) {
                    const mesh = self.meshes.get(guid);
                    if (mesh && mesh.material) {
                        mesh.material.opacity = 0.5 + pulse * 0.5;
                        mesh.material.transparent = true;
                        if (mesh.material.emissive) {
                            mesh.material.emissive.setHex(0x224466);
                        }
                    }
                }
            }

            self.renderer.render(self.scene, self.camera);
        }
    } catch(e) {
        console.error('渲染错误:', e);
    }
    // 同时用 RAF 和 setTimeout 保底（某些环境 RAF 可能被暂停）
    requestAnimationFrame(_animateFrame);
    setTimeout(function(){ if (!window._animAlive) requestAnimationFrame(_animateFrame); }, 50);
}
window._animAlive = true; // 标记渲染循环存活

class _BIMViewerClass {
    constructor() {
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.raycaster = null;
        this.mouse = null;

        this.meshes = new Map();       // guid -> THREE.Mesh
        this.meshStates = new Map();   // guid -> current state string
        this.highlightedGuids = new Set();
        this.onElementPicked = null;   // 外部回调：点击构件时通知 app
        this.selectionCallback = null;
        this._highlightWires = null;
        this._lastSelected = null;    // 最近点击的 GUID（"隐藏选中" fallback）

        // 框选模式
        this._boxSelectMode = false;
        this._boxSelectCallback = null;
        this._boxStart = null;         // {x, y} 画布坐标
        this._boxRect = null;          // CSS div 元素
        this._boxDragging = false;
        this._pivotTarget = null;      // 旋转中心目标点
        this.selectionCallback = null; // 外部设置的拾取回调
        this._animId = null;
        this._initialized = false;
    }

    // ------------------------------------------------------------------ //
    //  初始化
    // ------------------------------------------------------------------ //
    async init(container) {
        if (this._initialized) return;
        // 等待 three.js 动态导入完成
        await _ready;
        if (!THREE) {
            console.error('Three.js 未加载，无法初始化查看器');
            return;
        }
        if (!container) {
            console.error('viewer container 不存在');
            return;
        }
        this._initialized = true;
        this.container = container;

        // 场景
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0d0f12);

        // 模型根节点：将 IFC 坐标 (Z=高度) 转到 Three.js 坐标 (Y=高度)
        this._modelRoot = new THREE.Group();
        this._modelRoot.rotation.x = -Math.PI / 2;  // Z-up → Y-up
        this.scene.add(this._modelRoot);

        // 相机
        const w = container.clientWidth;
        const h = container.clientHeight;
        this.camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 10000);
        this.camera.position.set(30, 30, 30);

        // 渲染器
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(w, h);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        container.appendChild(this.renderer.domElement);

        // 控制器（左键旋转 + 中键滚轮缩放。右键平移自己写）
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.mouseButtons = {
            LEFT: THREE.MOUSE.ROTATE,
            MIDDLE: THREE.MOUSE.DOLLY,
            RIGHT: -1   // 右键不交给 OrbitControls
        };
        this.controls.enablePan = false;
        this.controls.enableKeys = false;

        // 右键平移：相机和目标一起按屏幕像素 1:1 移动
        this._panStart = null;
        const onPanMove = (e) => {
            if (!this._panStart || !(e.buttons & 2)) { this._panStart = null; return; }
            const dx = e.clientX - this._panStart.x;
            const dy = e.clientY - this._panStart.y;
            if (dx === 0 && dy === 0) return;
            // 像素 → 世界距离（在 target 深度处的屏幕像素对应的世界尺寸）
            const dist = this.camera.position.distanceTo(this.controls.target);
            const vFov = this.camera.fov * Math.PI / 180;
            const h = 2 * Math.tan(vFov / 2) * dist;
            const w = h * (this.renderer.domElement.clientWidth / this.renderer.domElement.clientHeight);
            const wx = (dx / this.renderer.domElement.clientWidth) * w;
            const wy = (dy / this.renderer.domElement.clientHeight) * h;
            // 相机局部坐标轴
            const fwd = new THREE.Vector3().subVectors(this.controls.target, this.camera.position).normalize();
            const rt = new THREE.Vector3().crossVectors(fwd, this.camera.up).normalize();
            const up = new THREE.Vector3().crossVectors(rt, fwd).normalize();
            // 同时移动相机和 target（保持视角不变）
            const move = rt.multiplyScalar(-wx).add(up.multiplyScalar(wy));
            this.camera.position.add(move);
            this.controls.target.add(move);
            this._pivotTarget = this.controls.target.clone();  // 同步，避免 lerp 拉偏
            this._panStart = { x: e.clientX, y: e.clientY };
        };
        this.renderer.domElement.addEventListener('pointermove', onPanMove);
        this.renderer.domElement.addEventListener('pointerup', () => { this._panStart = null; });

        // 灯光
        const ambient = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambient);
        const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
        dirLight.position.set(50, 80, 30);
        this.scene.add(dirLight);
        const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.3);
        dirLight2.position.set(-30, 40, -30);
        this.scene.add(dirLight2);

        // 地面网格
        const grid = new THREE.GridHelper(100, 50, 0x333333, 0x222222);
        grid.material.opacity = 0.5;
        grid.material.transparent = true;
        this.scene.add(grid);

        // 拾取
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();

        // 创建框选矩形 div
        this._boxRect = document.createElement('div');
        this._boxRect.style.cssText = 'position:absolute;border:2px dashed #0ff;background:rgba(0,255,255,0.08);display:none;pointer-events:none;z-index:99;';
        container.appendChild(this._boxRect);

        // 统一 pointer 事件：自己判断 click vs drag
        this._ptrDown = null;  // {x, y, button, time}
        this.renderer.domElement.addEventListener('pointerdown', (e) => this._onPointerDown(e));
        this.renderer.domElement.addEventListener('pointermove', (e) => this._onPointerMove(e));
        this.renderer.domElement.addEventListener('pointerup', (e) => this._onPointerUp(e));
        this.renderer.domElement.addEventListener('dblclick', (e) => this._onDoubleClick(e));
        // 阻止右键菜单（否则 OrbitControls 的右键平移会被菜单干扰）
        this.renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

        // 窗口缩放
        window.addEventListener('resize', () => this._onResize());

        // 渲染循环
        this._animate();
    }

    _animate() {
        // 用 setTimeout 启动渲染循环（某些环境下 RAF 首帧不触发）
        setTimeout(_animateFrame, 16);
    }

    _onResize() {
        if (!this.container) return;
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
    }

    // ------------------------------------------------------------------ //
    //  加载构件几何
    // ------------------------------------------------------------------ //
    async loadElement(guid, geomData) {
        if (this.meshes.has(guid)) return;
        if (!THREE || !this.scene) return;
        const { vertices, indices } = geomData;
        if (!vertices || vertices.length === 0) return;

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();

        const material = new THREE.MeshPhongMaterial({
            color: STATE_COLORS.unlinked.color,
            transparent: true,
            opacity: STATE_COLORS.unlinked.opacity,
            side: THREE.DoubleSide,
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.guid = guid;
        (this._modelRoot || this.scene).add(mesh);
        this.meshes.set(guid, mesh);
        this.meshStates.set(guid, 'unlinked');
    }

    /**
     * 从后端批量加载全部构件几何
     * @param {Array} elements - 构件元数据列表
     * @param {Function} onProgress - 进度回调(loaded, total)
     */
    async loadAllElements(elements, onProgress) {
        if (!this._initialized) {
            await this.init(document.getElementById('viewer-container'));
        }
        let loaded = 0;
        const total = elements.length;

        // 分批加载，避免一次性请求过多
        const BATCH = 8;
        for (let i = 0; i < elements.length; i += BATCH) {
            const batch = elements.slice(i, i + BATCH);
            const promises = batch.map(async (el) => {
                try {
                    const res = await fetch(`/api/element/${encodeURIComponent(el.guid)}/geometry`);
                    if (!res.ok) return;
                    const geom = await res.json();
                    if (geom.error) return;
                    await this.loadElement(el.guid, geom);
                } catch (e) {
                    console.warn('加载构件几何失败', el.guid, e);
                }
            });
            await Promise.all(promises);
            loaded += batch.length;
            if (onProgress) onProgress(loaded, total);
        }

        this.fitView();
    }

    // ------------------------------------------------------------------ //
    //  状态着色
    // ------------------------------------------------------------------ //
    setElementState(guid, state) {
        const mesh = this.meshes.get(guid);
        if (!mesh) return;

        // 若在高亮中，跳过普通状态更新
        if (this.highlightedGuids.has(guid) && state !== 'highlight') {
            this.meshStates.set(guid, state); // 记录，取消高亮后恢复
            return;
        }

        const conf = STATE_COLORS[state] || STATE_COLORS.unlinked;
        mesh.material.color.setHex(conf.color);
        mesh.material.opacity = conf.opacity;
        mesh.material.transparent = conf.transparent;
        mesh.visible = conf.visible;
        this.meshStates.set(guid, state);
    }

    /**
     * 批量设置状态（高效）
     * @param {Object} stateMap - { guid: state }
     * @param {Set} linkedGuids - 被关联的构件集合（不在其中的设为 unlinked）
     */
    applyStates(stateMap, linkedGuids) {
        for (const [guid, mesh] of this.meshes) {
            if (this.highlightedGuids.has(guid)) continue;
            const isLinked = linkedGuids && linkedGuids.has(guid);
            const state = isLinked ? (stateMap[guid] || 'pending') : 'unlinked';
            const conf = STATE_COLORS[state] || STATE_COLORS.unlinked;
            mesh.material.color.setHex(conf.color);
            mesh.material.opacity = conf.opacity;
            mesh.material.transparent = conf.transparent;
            mesh.visible = conf.visible;
            this.meshStates.set(guid, state);
        }
    }

    // ------------------------------------------------------------------ //
    //  高亮 / 选区
    // ------------------------------------------------------------------ //
    highlightElements(guids) {
        this.clearHighlight();

        for (const guid of guids) {
            const mesh = this.meshes.get(guid);
            if (!mesh) continue;

            // 方案A: 材质颜色+发光
            mesh.material.color.setHex(STATE_COLORS.highlight.color);
            mesh.material.transparent = true;
            mesh.material.opacity = 1.0;
            mesh.visible = true;
            if (mesh.material.emissive) mesh.material.emissive.setHex(0x224466);

            // 方案B: 添加亮色线框（确保一定能看到）
            if (mesh.geometry) {
                try {
                    const wireframe = new THREE.LineSegments(
                        new THREE.EdgesGeometry(mesh.geometry),
                        new THREE.LineBasicMaterial({ color: 0x00ffff, linewidth: 2, transparent: true, opacity: 0.9 })
                    );
                    wireframe.position.copy(mesh.position);
                    wireframe.rotation.copy(mesh.rotation);
                    wireframe.scale.copy(mesh.scale).multiplyScalar(1.01); // 稍微放大避免遮挡
                    wireframe.userData._isHighlightWire = true;
                    wireframe.userData._refGuid = guid;
                    (this._modelRoot || this.scene).add(wireframe);
                    this._highlightWires = this._highlightWires || new Map();
                    this._highlightWires.set(guid, wireframe);
                } catch(e) { /* 线框创建失败则回退到材质方案 */ }
            }

            this.highlightedGuids.add(guid);
        }

        // 强制立即渲染一帧
        if (this.renderer && this.scene && this.camera) {
            this.renderer.render(this.scene, this.camera);
        }
        this._updateIndicator();
    }

    _updateIndicator() {
        var el = document.getElementById('selection-indicator');
        if (el) { el.textContent = this.highlightedGuids.size > 0 ? '已选中 ' + this.highlightedGuids.size + ' 个构件' : ''; }
    }

    clearHighlight() {
        // 清除线框
        if (this._highlightWires) {
            const parent = this._modelRoot || this.scene;
            for (const wire of this._highlightWires.values()) {
                parent.remove(wire);
                if (wire.geometry) wire.geometry.dispose();
                if (wire.material) wire.material.dispose();
            }
            this._highlightWires.clear();
        }

        for (const guid of this.highlightedGuids) {
            const state = this.meshStates.get(guid) || 'unlinked';
            const conf = STATE_COLORS[state] || STATE_COLORS.unlinked;
            const mesh = this.meshes.get(guid);
            if (mesh) {
                mesh.material.color.setHex(conf.color);
                mesh.material.opacity = conf.opacity;
                mesh.material.transparent = conf.transparent;
                mesh.visible = conf.visible;
                if (mesh.material.emissive) mesh.material.emissive.setHex(0x000000);
            }
        }
        this.highlightedGuids.clear();
        this._updateIndicator();
    }

    /**
     * 设置选区模式：点击构件时回调
     * @param {Function|null} callback - guid => void，null 表示关闭选区
     */
    setPickMode(callback) {
        this.selectionCallback = callback;
        this.renderer.domElement.style.cursor = callback ? 'crosshair' : 'pointer';
    }

    _onClick(event) {
        this._clickCount = (this._clickCount || 0) + 1;
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);
        // 拾取时包括不可见的吗？不，只拾取可见的
        const meshes = Array.from(this.meshes.values()).filter(m => m.visible);
        const intersects = this.raycaster.intersectObjects(meshes, false);

        if (intersects.length > 0) {
            const guid = intersects[0].object.userData.guid;
            // 始终高亮被点击的构件（单击选中）
            if (!this.selectionCallback) {
                // 普通模式：单击选中构件
                this.highlightElements([guid]);
                this._lastSelected = guid;  // 记录，供"隐藏选中"按钮 fallback
                if (this.onElementPicked) this.onElementPicked(guid);
            } else {
                // 关联模式：交给回调处理
                this.selectionCallback(guid);
            }
        } else {
            // 点击空白处取消高亮（非关联模式）
            if (!this.selectionCallback) {
                this.clearHighlight();
            }
        }
    }

    /**
     * 双击左键：把旋转中心移到构件表面（右键不影响）
     */
    _onDoubleClick(e) {
        if (e.button !== 0) return;  // 仅左键
        if (this._boxSelectMode) return;
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const visibleMeshes = Array.from(this.meshes.values()).filter(m => m.visible);
        const hits = this.raycaster.intersectObjects(visibleMeshes, false);
        if (hits.length > 0 && this.controls) {
            this._pivotTarget = hits[0].point.clone();
        }
    }

    // ------------------------------------------------------------------ //
    //  框选模式
    // ------------------------------------------------------------------ //
    /**
     * 进入/退出框选模式
     * @param {Function|null} callback - (guids: string[]) => void
     */
    setBoxSelectMode(callback) {
        this._boxSelectMode = !!callback;
        this._boxSelectCallback = callback;
        this.renderer.domElement.style.cursor = callback ? 'crosshair' : 'pointer';
        // 框选时禁用左键旋转
        if (this.controls) this.controls.enableRotate = !callback;
    }

    _onPointerDown(e) {
        this._ptrDown = { x: e.clientX, y: e.clientY, button: e.button, time: Date.now() };

        // 右键 → 启动自定义平移
        if (e.button === 2) {
            this._pivotTarget = null;  // 停止任何残留的 lerp
            this._panStart = { x: e.clientX, y: e.clientY };
            return;
        }

        // 框选模式
        if (this._boxSelectMode) {
            this._boxDragging = true;
            const rect = this.renderer.domElement.getBoundingClientRect();
            this._boxStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            this._boxRect.style.display = 'block';
            this._boxRect.style.left = this._boxStart.x + 'px';
            this._boxRect.style.top = this._boxStart.y + 'px';
            this._boxRect.style.width = '0px';
            this._boxRect.style.height = '0px';
            e.preventDefault();
        }
    }

    _onPointerMove(e) {
        if (!this._boxSelectMode || !this._boxDragging) return;
        const rect = this.renderer.domElement.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const left = Math.min(this._boxStart.x, x);
        const top = Math.min(this._boxStart.y, y);
        const w = Math.abs(x - this._boxStart.x);
        const h = Math.abs(y - this._boxStart.y);
        this._boxRect.style.left = left + 'px';
        this._boxRect.style.top = top + 'px';
        this._boxRect.style.width = w + 'px';
        this._boxRect.style.height = h + 'px';
    }

    _onPointerUp(e) {
        const ptrDown = this._ptrDown;
        this._ptrDown = null;
        if (!ptrDown) return;

        const dx = Math.abs(e.clientX - ptrDown.x);
        const dy = Math.abs(e.clientY - ptrDown.y);
        const isDrag = dx > 4 || dy > 4;  // 移动超过 4px 算拖拽

        // --- 框选模式处理 ---
        if (this._boxSelectMode && this._boxDragging) {
            this._boxDragging = false;
            this._boxRect.style.display = 'none';
            if (!isDrag) return; // 没拖够 → 不框选，交给下面的 click 逻辑

            const rect = this.renderer.domElement.getBoundingClientRect();
            const ex = e.clientX - rect.left;
            const ey = e.clientY - rect.top;
            const sx = Math.min(this._boxStart.x, ex);
            const sy = Math.min(this._boxStart.y, ey);
            const sw = Math.max(Math.abs(ex - this._boxStart.x), 1);
            const sh = Math.max(Math.abs(ey - this._boxStart.y), 1);

            const selected = [];
            const canvasW = rect.width;
            const canvasH = rect.height;
            for (const [guid, mesh] of this.meshes) {
                if (!mesh.visible) continue;
                const box = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
                const proj = box.clone().project(this.camera);
                const sx2 = (proj.x * 0.5 + 0.5) * canvasW;
                const sy2 = (-proj.y * 0.5 + 0.5) * canvasH;
                if (sx2 >= sx && sx2 <= sx + sw && sy2 >= sy && sy2 <= sy + sh) {
                    selected.push(guid);
                }
            }
            if (selected.length > 0 && this._boxSelectCallback) {
                this._boxSelectCallback(selected);
                this.highlightElements(selected);
            }
            this._boxStart = null;
            return;
        }

        // --- 普通模式：只有左键 + 没拖拽 → 触发点击选中 ---
        if (!this._boxSelectMode && ptrDown.button === 0 && !isDrag) {
            this._onClick(e);
        }
    }

    // ------------------------------------------------------------------ //
    //  颜色自定义
    // ------------------------------------------------------------------ //
    /**
     * 更新状态颜色并刷新所有构件
     * @param {Object} colors - { stateName: { color: hexStr, opacity: number } }
     */
    setStateColors(colors) {
        for (const [state, vals] of Object.entries(colors)) {
            if (STATE_COLORS[state]) {
                if (vals.color !== undefined) STATE_COLORS[state].color = parseInt(vals.color, 16);
                if (vals.opacity !== undefined) STATE_COLORS[state].opacity = parseFloat(vals.opacity);
                if (vals.transparent !== undefined) STATE_COLORS[state].transparent = !!vals.transparent;
            }
        }
        // 重新应用状态到所有构件
        const linked = new Set();
        for (const [guid, state] of this.meshStates) {
            if (state !== 'unlinked') linked.add(guid);
            const conf = STATE_COLORS[state] || STATE_COLORS.unlinked;
            const mesh = this.meshes.get(guid);
            if (mesh && !this.highlightedGuids.has(guid)) {
                mesh.material.color.setHex(conf.color);
                mesh.material.opacity = conf.opacity;
                mesh.material.transparent = conf.transparent;
                mesh.visible = conf.visible;
            }
        }
    }

    /** 获取当前颜色配置（供 UI 读取） */
    getStateColors() {
        const out = {};
        for (const [k, v] of Object.entries(STATE_COLORS)) {
            out[k] = {
                label: v.label,
                color: '#' + v.color.toString(16).padStart(6, '0'),
                opacity: v.opacity,
            };
        }
        return out;
    }

    // ------------------------------------------------------------------ //
    //  视图操作
    // ------------------------------------------------------------------ //
    fitView() {
        if (this.meshes.size === 0) return;

        const box = new THREE.Box3();
        for (const mesh of this.meshes.values()) {
            if (mesh.visible) {
                box.expandByObject(mesh);
            }
        }
        if (box.isEmpty()) {
            // 全部不可见时用所有 mesh
            for (const mesh of this.meshes.values()) {
                box.expandByObject(mesh);
            }
        }
        if (box.isEmpty()) return;

        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const fov = this.camera.fov * (Math.PI / 180);
        let dist = maxDim / (2 * Math.tan(fov / 2));
        dist *= 1.8; // 留点边距

        this.camera.position.set(
            center.x + dist * 1.0,
            center.y + dist * 0.6,
            center.z + dist * 1.0
        );
        this.camera.lookAt(center);
        this.controls.target.copy(center);
        this._pivotTarget = center.clone(); // 旋转中心初始化为模型中心
        this.controls.update();

        // 调整网格大小
        if (maxDim > 0) {
            const gridSize = Math.ceil(maxDim * 2);
            // 简单重建网格
        }
    }

    clear() {
        const parent = this._modelRoot || this.scene;
        for (const mesh of this.meshes.values()) {
            parent.remove(mesh);
            mesh.geometry.dispose();
            mesh.material.dispose();
        }
        this.meshes.clear();
        this.meshStates.clear();
        this.highlightedGuids.clear();
    }
}

// 全局单例
window.BIMViewer = new _BIMViewerClass();
