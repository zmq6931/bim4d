"""
IFC 解析服务 - 使用 IfcOpenShell 解析 .ifc 文件
提供：构件元数据提取、几何数据提取
"""
import ifcopenshell
import ifcopenshell.geom
import math


class IfcService:
    """IFC 文件解析器，单例缓存已加载的模型"""

    def __init__(self):
        self._model = None
        self._file_path = None
        self._elements_cache = None  # 缓存构件元数据
        self._geom_settings = None

    # ------------------------------------------------------------------ #
    #  加载
    # ------------------------------------------------------------------ #
    def load(self, file_path: str):
        """加载 IFC 文件"""
        self._model = ifcopenshell.open(file_path)
        self._file_path = file_path
        self._elements_cache = None
        # 几何提取设置
        self._geom_settings = ifcopenshell.geom.settings()
        # IfcOpenShell 0.8+ 使用字符串设置名
        self._geom_settings.set("use-world-coords", True)
        self._geom_settings.set("weld-vertices", True)
        self._geom_settings.set("apply-default-materials", True)
        return self.get_elements()

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    # ------------------------------------------------------------------ #
    #  构件元数据
    # ------------------------------------------------------------------ #
    def get_elements(self):
        """返回全部构件的元数据（不含几何）"""
        if self._model is None:
            return []

        if self._elements_cache is not None:
            return self._elements_cache

        # 可显示的 IfcProduct 子类（建筑构件）
        # 注意：IfcWall 会包含 IfcWallStandardCase（子类），所以只列 IfcWall
        # 用 by_type 遍历时按 GUID 去重，避免子类重复
        display_classes = [
            "IfcWall", "IfcSlab", "IfcColumn",
            "IfcBeam", "IfcDoor", "IfcWindow", "IfcRoof", "IfcStair",
            "IfcRailing", "IfcCurtainWall", "IfcFooting", "IfcPile",
            "IfcBuildingElementProxy", "IfcCovering", "IfcFlowSegment",
            "IfcFlowFitting", "IfcDuctSegment", "IfcPipeSegment",
            "IfcMember", "IfcPlate", "IfcRamp", "IfcSpace",
        ]

        seen_guids = set()
        elements = []
        for cls_name in display_classes:
            try:
                instances = self._model.by_type(cls_name)
            except Exception:
                continue
            for inst in instances:
                meta = self._extract_meta(inst)
                if meta and meta["guid"] not in seen_guids:
                    seen_guids.add(meta["guid"])
                    elements.append(meta)

        self._elements_cache = elements
        return elements

    def _extract_meta(self, inst) -> dict | None:
        """提取单个构件的元数据"""
        try:
            guid = getattr(inst, "GlobalId", None)
            if not guid:
                return None
            name = getattr(inst, "Name", None) or ""
            # 类型名：IfcWall -> "Wall"
            type_name = inst.is_a()
            short_type = type_name.replace("Ifc", "").replace("StandardCase", "")

            # 楼层：通过 ContainedInStructure 关系
            floor = ""
            try:
                rels = getattr(inst, "ContainedInStructure", None)
                if rels:
                    for rel in rels:
                        sp = rel.RelatingStructure
                        floor = getattr(sp, "Name", "") or ""
                        if floor:
                            break
            except Exception:
                pass

            # 如果 ContainedInStructure 没拿到，尝试 Decomposes（嵌套构件）
            if not floor:
                try:
                    decomposes = getattr(inst, "Decomposes", None)
                    if decomposes:
                        for rel in decomposes:
                            parent = rel.RelatingObject
                            floor = getattr(parent, "Name", "") or ""
                            if floor:
                                break
                except Exception:
                    pass

            return {
                "guid": guid,
                "name": name,
                "type": short_type,
                "ifcType": type_name,
                "floor": floor,
            }
        except Exception:
            return None

    # ------------------------------------------------------------------ #
    #  几何数据
    # ------------------------------------------------------------------ #
    def get_geometry(self, guid: str) -> dict | None:
        """返回单个构件的几何（vertices + indices）"""
        if self._model is None:
            return None
        try:
            inst = self._model.by_guid(guid)
        except Exception:
            return None
        if inst is None:
            return None

        try:
            shape = ifcopenshell.geom.create_shape(self._geom_settings, inst)
        except Exception as e:
            return {"error": f"几何生成失败: {e}"}

        verts = shape.geometry.verts  # flat: [x,y,z, x,y,z, ...]
        faces = shape.geometry.faces  # flat: [i,j,k, i,j,k, ...]

        # IfcOpenShell verts 是 float，faces 是 int
        return {
            "vertices": list(verts),
            "indices": list(faces),
        }

    def get_all_bounding_info(self) -> dict:
        """粗略估算模型包围盒，用于前端相机定位"""
        if self._model is None:
            return {}
        try:
            # 用项目上下文中的 Building/Elevation 推断，失败则返回空
            storeys = self._model.by_type("IfcBuildingStorey")
            if not storeys:
                return {}
            min_z = min(getattr(s, "Elevation", 0) or 0 for s in storeys)
            return {"minElevation": min_z}
        except Exception:
            return {}
