"""
生成测试 IFC 文件 - 使用 IfcOpenShell 0.8 新版 API
包含：3面墙(1层) + 2块楼板(1层) + 3面墙(2层)，用于验证 BIM 4D 全流程
"""
import os
import ifcopenshell
import ifcopenshell.api as api
from ifcopenshell import guid as G

OUTPUT = os.path.join(os.path.dirname(__file__), "sample_building.ifc")


def main():
    # 创建空模型
    f = api.run("project.create_file")

    # 所有者历史
    api.run("owner.add_person", f)
    api.run("owner.add_organisation", f)
    api.run("owner.create_owner_history", f)

    # 项目必须先创建，单位才能挂上去
    project = api.run("root.create_entity", f, ifc_class="IfcProject", name="BIM4D测试项目")

    # 单位（米）
    api.run("unit.assign_unit", f, length={"is_metric": True, "raw": "METERS"})

    # 空间层级
    site = api.run("root.create_entity", f, ifc_class="IfcSite", name="场地")
    building = api.run("root.create_entity", f, ifc_class="IfcBuilding", name="测试楼")
    storey1 = api.run("root.create_entity", f, ifc_class="IfcBuildingStorey", name="1层")
    storey2 = api.run("root.create_entity", f, ifc_class="IfcBuildingStorey", name="2层")

    # 设置楼层标高
    storey1.Elevation = 0.0
    storey2.Elevation = 3.0

    # 层级聚合
    api.run("aggregate.assign_object", f, products=[site], relating_object=project)
    api.run("aggregate.assign_object", f, products=[building], relating_object=site)
    api.run("aggregate.assign_object", f, products=[storey1, storey2], relating_object=building)

    # 上下文（Body, ModelView）
    ctx = api.run(
        "context.add_context",
        f,
        context_type="Model",
        context_identifier="Body",
        target_view="MODEL_VIEW",
    )

    # ---- 创建构件 ----
    def make_wall(name, storey, x, y, length=5.0, thickness=0.2, height=3.0, z_offset=0.0):
        wall = api.run("root.create_entity", f, ifc_class="IfcWallStandardCase", name=name)
        api.run("spatial.assign_container", f, products=[wall], relating_structure=storey)
        # 生成墙的表示（沿 X 轴方向，长度=length，厚度=thickness，高度=height）
        representation = api.run(
            "geometry.add_wall_representation",
            f,
            context=ctx,
            length=length,
            height=height,
            thickness=thickness,
        )
        api.run("geometry.assign_representation", f, product=wall, representation=representation)
        # 平移到指定位置（4x4 矩阵）
        api.run(
            "geometry.edit_object_placement",
            f,
            product=wall,
            matrix=[[1, 0, 0, x], [0, 1, 0, y], [0, 0, 1, z_offset], [0, 0, 0, 1]],
        )
        return wall

    def make_slab(name, storey, x, y, width=5.0, depth=5.0, thickness=0.2, z_offset=0.0):
        slab = api.run("root.create_entity", f, ifc_class="IfcSlab", name=name)
        api.run("spatial.assign_container", f, products=[slab], relating_structure=storey)
        # 生成楼板表示（轮廓点 XY 平面 + 厚度拉伸）
        representation = api.run(
            "geometry.add_slab_representation",
            f,
            context=ctx,
            depth=thickness,
            polyline=[
                (x, y),
                (x + width, y),
                (x + width, y + depth),
                (x, y + depth),
                (x, y),
            ],
        )
        api.run("geometry.assign_representation", f, product=slab, representation=representation)
        api.run(
            "geometry.edit_object_placement",
            f,
            product=slab,
            matrix=[[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, z_offset], [0, 0, 0, 1]],
        )
        return slab

    # 一层
    make_wall("墙A", storey1, 0.0, 0.0)
    make_wall("墙B", storey1, 5.0, 0.0)
    make_wall("墙C", storey1, 10.0, 0.0)
    make_slab("楼板1", storey1, 0.0, 0.0, width=5.0, depth=5.0, thickness=0.2, z_offset=-0.2)
    make_slab("楼板2", storey1, 5.0, 0.0, width=5.0, depth=5.0, thickness=0.2, z_offset=-0.2)

    # 二层
    make_wall("二层墙A", storey2, 0.0, 0.0, z_offset=3.0)
    make_wall("二层墙B", storey2, 5.0, 0.0, z_offset=3.0)
    make_wall("二层墙C", storey2, 10.0, 0.0, z_offset=3.0)
    make_slab("二层楼板", storey2, 0.0, 0.0, width=15.0, depth=5.0, thickness=0.2, z_offset=2.8)

    f.write(OUTPUT)
    print(f"✓ IFC 测试文件已生成: {OUTPUT}")

    # 验证
    m = ifcopenshell.open(OUTPUT)
    walls = len(m.by_type("IfcWall")) + len(m.by_type("IfcWallStandardCase"))
    slabs = len(m.by_type("IfcSlab"))
    storeys = len(m.by_type("IfcBuildingStorey"))
    print(f"  构件统计：墙 {walls}，楼板 {slabs}，楼层 {storeys}")

    # 验证几何
    import ifcopenshell.geom as geom
    settings = geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)
    elems = m.by_type("IfcWallStandardCase") + m.by_type("IfcSlab")
    for e in elems[:2]:
        try:
            shape = geom.create_shape(settings, e)
            print(f"  几何验证 {e.Name}: {len(shape.geometry.verts)} 顶点, {len(shape.geometry.faces)} 面索引")
        except Exception as ex:
            print(f"  几何失败 {e.Name}: {ex}")


if __name__ == "__main__":
    main()
