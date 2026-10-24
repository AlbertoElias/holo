# Blend probe for AR Quick Look: black squares at 25/50/75% opacity, 10 cm, 15 cm apart, stuck to a wall.
import sys
from pxr import Usd, UsdGeom, UsdShade, Sdf, Gf, UsdUtils
out = sys.argv[1]
usda = out.replace('.usdz', '.usda')
st = Usd.Stage.CreateNew(usda)
UsdGeom.SetStageUpAxis(st, UsdGeom.Tokens.y); UsdGeom.SetStageMetersPerUnit(st, 1.0)
root = UsdGeom.Xform.Define(st, '/Probe'); st.SetDefaultPrim(root.GetPrim())
p = root.GetPrim()
p.CreateAttribute('preliminary:anchoring:type', Sdf.ValueTypeNames.Token).Set('plane')
p.CreateAttribute('preliminary:planeAnchoring:alignment', Sdf.ValueTypeNames.Token).Set('vertical')
for i, a in enumerate([.25, .5, .75]):
    name = f'P{int(a*100)}'
    mesh = UsdGeom.Mesh.Define(st, f'/Probe/{name}')
    x = (i - 1) * .15; s = .05
    # vertical anchoring: the anchor's +Z points out of the wall, so the squares lie in the XY plane facing +Z
    mesh.CreatePointsAttr([Gf.Vec3f(x - s, -s, .001), Gf.Vec3f(x + s, -s, .001), Gf.Vec3f(x + s, s, .001), Gf.Vec3f(x - s, s, .001)])
    mesh.CreateFaceVertexCountsAttr([4]); mesh.CreateFaceVertexIndicesAttr([0, 1, 2, 3])
    mesh.CreateNormalsAttr([Gf.Vec3f(0, 0, 1)] * 4); mesh.SetNormalsInterpolation('vertex')
    mesh.CreateDoubleSidedAttr(True)
    mat = UsdShade.Material.Define(st, f'/Probe/{name}Mat')
    sh = UsdShade.Shader.Define(st, f'/Probe/{name}Mat/Surface')
    sh.CreateIdAttr('UsdPreviewSurface')
    sh.CreateInput('diffuseColor', Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(0, 0, 0))
    sh.CreateInput('opacity', Sdf.ValueTypeNames.Float).Set(a)
    sh.CreateInput('roughness', Sdf.ValueTypeNames.Float).Set(1.0)
    sh.CreateInput('metallic', Sdf.ValueTypeNames.Float).Set(0.0)
    mat.CreateSurfaceOutput().ConnectToSource(sh.ConnectableAPI(), 'surface')
    UsdShade.MaterialBindingAPI.Apply(mesh.GetPrim()).Bind(mat)
st.GetRootLayer().Save()
UsdUtils.CreateNewUsdzPackage(usda, out)
print('wrote', out)
