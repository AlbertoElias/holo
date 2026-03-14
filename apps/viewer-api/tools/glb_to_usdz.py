#!/usr/bin/env python3
"""Convert a GLB file to USDZ with skeletal animation support.

Usage: python3 glb_to_usdz.py <input.glb> <output.usdz>

Dependencies: pip3 install usd-core pygltflib numpy
"""

import sys
import struct
import tempfile
import os
import math
import numpy as np
from pathlib import Path

import pygltflib
from pxr import Usd, UsdGeom, UsdSkel, UsdShade, Gf, Vt, Sdf, UsdUtils, Kind


def _accessor_data(gltf: pygltflib.GLTF2, accessor_index: int) -> np.ndarray:
    """Read data from a glTF accessor into a numpy array."""
    accessor = gltf.accessors[accessor_index]
    buffer_view = gltf.bufferViews[accessor.bufferView]
    buffer = gltf.buffers[buffer_view.buffer]

    # Get the binary data blob
    data = gltf.binary_blob()

    byte_offset = (buffer_view.byteOffset or 0) + (accessor.byteOffset or 0)

    component_type_map = {
        5120: np.int8,
        5121: np.uint8,
        5122: np.int16,
        5123: np.uint16,
        5125: np.uint32,
        5126: np.float32,
    }
    dtype = component_type_map[accessor.componentType]

    type_count_map = {
        "SCALAR": 1,
        "VEC2": 2,
        "VEC3": 3,
        "VEC4": 4,
        "MAT2": 4,
        "MAT3": 9,
        "MAT4": 16,
    }
    num_components = type_count_map[accessor.type]

    count = accessor.count
    element_size = np.dtype(dtype).itemsize * num_components
    byte_stride = buffer_view.byteStride or element_size

    if byte_stride == element_size:
        total_bytes = count * element_size
        raw = data[byte_offset : byte_offset + total_bytes]
        arr = np.frombuffer(raw, dtype=dtype)
    else:
        # Strided access
        arr = np.empty(count * num_components, dtype=dtype)
        for i in range(count):
            offset = byte_offset + i * byte_stride
            chunk = data[offset : offset + element_size]
            arr[i * num_components : (i + 1) * num_components] = np.frombuffer(
                chunk, dtype=dtype
            )

    if num_components > 1:
        arr = arr.reshape(count, num_components)

    return arr


def _np_mat4_to_gf(m: np.ndarray) -> Gf.Matrix4d:
    """Convert a 4x4 numpy array (column-major glTF) to Gf.Matrix4d (row-major USD).

    Gf.Matrix4d requires native Python floats, not numpy scalars.
    """
    f = m.astype(float)
    return Gf.Matrix4d(
        f[0, 0], f[1, 0], f[2, 0], f[3, 0],
        f[0, 1], f[1, 1], f[2, 1], f[3, 1],
        f[0, 2], f[1, 2], f[2, 2], f[3, 2],
        f[0, 3], f[1, 3], f[2, 3], f[3, 3],
    )


def _quat_to_gf(q: np.ndarray) -> Gf.Quatf:
    """Convert glTF quaternion [x,y,z,w] to Gf.Quatf(w, x, y, z)."""
    return Gf.Quatf(float(q[3]), float(q[0]), float(q[1]), float(q[2]))


def _trs_to_matrix(t, r, s) -> Gf.Matrix4d:
    """Compose TRS into a 4x4 matrix."""
    mat = Gf.Matrix4d(1.0)
    if s is not None:
        mat_s = Gf.Matrix4d(1.0)
        mat_s[0][0] = s[0]
        mat_s[1][1] = s[1]
        mat_s[2][2] = s[2]
        mat = mat_s
    if r is not None:
        q = Gf.Quatd(float(r[3]), float(r[0]), float(r[1]), float(r[2]))
        rot_mat = Gf.Matrix4d(1.0)
        rot_mat.SetRotate(q)
        mat = mat * rot_mat
    if t is not None:
        mat_t = Gf.Matrix4d(1.0)
        mat_t.SetTranslate(Gf.Vec3d(float(t[0]), float(t[1]), float(t[2])))
        mat = mat * mat_t
    return mat


def _node_local_transform(node: pygltflib.Node) -> Gf.Matrix4d:
    """Get the local transform matrix of a glTF node."""
    if node.matrix is not None:
        m = np.array(node.matrix, dtype=np.float64).reshape(4, 4)
        return _np_mat4_to_gf(m)
    t = node.translation
    r = node.rotation
    s = node.scale
    return _trs_to_matrix(t, r, s)


def _sanitize_name(name: str) -> str:
    """Sanitize a name for use as a USD prim path token."""
    if not name:
        return "unnamed"
    result = ""
    for i, c in enumerate(name):
        if c.isalnum() or c == "_":
            result += c
        else:
            result += "_"
    if result and result[0].isdigit():
        result = "_" + result
    return result or "unnamed"


def _collect_joint_hierarchy(gltf: pygltflib.GLTF2, skin: pygltflib.Skin):
    """Collect joint paths and hierarchy for a skin."""
    joint_indices = skin.joints
    joint_names = []
    joint_paths = []

    # Build parent mapping
    parent_map = {}
    for node_idx in joint_indices:
        node = gltf.nodes[node_idx]
        if node.children:
            for child_idx in node.children:
                if child_idx in joint_indices:
                    parent_map[child_idx] = node_idx

    # Find root joints (no parent within this skin)
    root_joints = [j for j in joint_indices if j not in parent_map]

    # Build paths via BFS
    path_map = {}
    queue = list(root_joints)
    for root_idx in root_joints:
        node = gltf.nodes[root_idx]
        name = _sanitize_name(node.name or f"joint_{root_idx}")
        path_map[root_idx] = name

    visited = set()
    while queue:
        idx = queue.pop(0)
        if idx in visited:
            continue
        visited.add(idx)
        node = gltf.nodes[idx]
        if node.children:
            for child_idx in node.children:
                if child_idx in joint_indices and child_idx not in visited:
                    child_node = gltf.nodes[child_idx]
                    child_name = _sanitize_name(
                        child_node.name or f"joint_{child_idx}"
                    )
                    path_map[child_idx] = f"{path_map[idx]}/{child_name}"
                    queue.append(child_idx)

    # Ordered by the skin's joint list
    for idx in joint_indices:
        node = gltf.nodes[idx]
        joint_names.append(_sanitize_name(node.name or f"joint_{idx}"))
        joint_paths.append(path_map.get(idx, _sanitize_name(node.name or f"joint_{idx}")))

    return joint_paths, joint_names, root_joints


def convert_glb_to_usdz(input_path: str, output_path: str) -> None:
    """Convert a GLB file to USDZ format with skeletal animation."""
    gltf = pygltflib.GLTF2.load(input_path)

    with tempfile.TemporaryDirectory() as tmp_dir:
        usda_path = os.path.join(tmp_dir, "model.usda")
        stage = Usd.Stage.CreateNew(usda_path)
        stage.SetMetadata("metersPerUnit", 1.0)
        stage.SetMetadata("upAxis", UsdGeom.Tokens.y)

        UsdGeom.SetStageMetersPerUnit(stage, 1.0)
        UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.y)

        root_prim = UsdGeom.Xform.Define(stage, "/Root")
        stage.SetDefaultPrim(root_prim.GetPrim())
        Usd.ModelAPI(root_prim.GetPrim()).SetKind(Kind.Tokens.component)

        # Track materials
        material_map = {}

        # Process skins (skeletons)
        skeleton_map = {}  # skin_index -> (skel_root_path, joint_paths)

        for skin_idx, skin in enumerate(gltf.skins or []):
            skin_name = _sanitize_name(skin.name or f"skeleton_{skin_idx}")
            skel_root_path = f"/Root/{skin_name}"

            joint_paths, joint_names, root_joints = _collect_joint_hierarchy(
                gltf, skin
            )

            # Create SkelRoot
            skel_root = UsdSkel.Root.Define(stage, skel_root_path)

            # Create Skeleton
            skel_path = f"{skel_root_path}/Skeleton"
            skeleton = UsdSkel.Skeleton.Define(stage, skel_path)

            # Set joints
            skeleton.GetJointsAttr().Set(joint_paths)

            # Compute bind transforms
            if skin.inverseBindMatrices is not None:
                ibm_data = _accessor_data(gltf, skin.inverseBindMatrices)
                bind_list = []
                rest_list = []
                for i, joint_idx in enumerate(skin.joints):
                    ibm = ibm_data[i].reshape(4, 4)
                    ibm_mat = _np_mat4_to_gf(ibm)
                    bind_list.append(ibm_mat.GetInverse())

                    # Rest transform = local transform of the joint node
                    node = gltf.nodes[joint_idx]
                    rest_list.append(_node_local_transform(node))

                skeleton.GetBindTransformsAttr().Set(Vt.Matrix4dArray(bind_list))
                skeleton.GetRestTransformsAttr().Set(Vt.Matrix4dArray(rest_list))

            skeleton_map[skin_idx] = (skel_root_path, joint_paths, skel_path)

        # Process meshes from scene nodes
        scene_idx = gltf.scene if gltf.scene is not None else 0
        scene = gltf.scenes[scene_idx] if gltf.scenes else None
        if not scene:
            print("No scene found in GLB", file=sys.stderr)
            sys.exit(1)

        mesh_counter = [0]

        def process_node(node_idx: int, parent_path: str, parent_xform: Gf.Matrix4d):
            node = gltf.nodes[node_idx]
            node_name = _sanitize_name(node.name or f"node_{node_idx}")
            node_path = f"{parent_path}/{node_name}"

            local_xform = _node_local_transform(node)

            # If this node has a mesh
            if node.mesh is not None:
                mesh = gltf.meshes[node.mesh]
                mesh_name = _sanitize_name(mesh.name or f"mesh_{mesh_counter[0]}")
                mesh_counter[0] += 1

                # Determine if this mesh is skinned
                skin_idx = node.skin
                has_skin = skin_idx is not None and skin_idx in skeleton_map

                if has_skin:
                    skel_root_path, joint_paths, skel_path = skeleton_map[skin_idx]
                    actual_mesh_path = f"{skel_root_path}/{mesh_name}"
                else:
                    actual_mesh_path = f"{parent_path}/{mesh_name}"

                for prim_idx, primitive in enumerate(mesh.primitives):
                    prim_name = (
                        mesh_name if len(mesh.primitives) == 1
                        else f"{mesh_name}_prim{prim_idx}"
                    )
                    if has_skin:
                        prim_path = f"{skel_root_path}/{prim_name}"
                    else:
                        prim_path = f"{parent_path}/{prim_name}"

                    usd_mesh = UsdGeom.Mesh.Define(stage, prim_path)

                    # Positions
                    if "POSITION" in primitive.attributes.__dict__ and primitive.attributes.POSITION is not None:
                        positions = _accessor_data(gltf, primitive.attributes.POSITION)
                        points = Vt.Vec3fArray(
                            [Gf.Vec3f(float(p[0]), float(p[1]), float(p[2])) for p in positions]
                        )
                        usd_mesh.GetPointsAttr().Set(points)

                    # Normals
                    if hasattr(primitive.attributes, 'NORMAL') and primitive.attributes.NORMAL is not None:
                        normals = _accessor_data(gltf, primitive.attributes.NORMAL)
                        normal_arr = Vt.Vec3fArray(
                            [Gf.Vec3f(float(n[0]), float(n[1]), float(n[2])) for n in normals]
                        )
                        usd_mesh.GetNormalsAttr().Set(normal_arr)
                        usd_mesh.SetNormalsInterpolation("vertex")

                    # UVs
                    if hasattr(primitive.attributes, 'TEXCOORD_0') and primitive.attributes.TEXCOORD_0 is not None:
                        uvs = _accessor_data(gltf, primitive.attributes.TEXCOORD_0)
                        uv_arr = Vt.Vec2fArray(
                            [Gf.Vec2f(float(uv[0]), 1.0 - float(uv[1])) for uv in uvs]
                        )
                        primvar_api = UsdGeom.PrimvarsAPI(usd_mesh.GetPrim())
                        primvar_api.CreatePrimvar(
                            "st", Sdf.ValueTypeNames.TexCoord2fArray, UsdGeom.Tokens.vertex
                        ).Set(uv_arr)

                    # Indices
                    if primitive.indices is not None:
                        indices = _accessor_data(gltf, primitive.indices).flatten()
                        face_vertex_indices = Vt.IntArray(indices.astype(np.int32).tolist())
                        usd_mesh.GetFaceVertexIndicesAttr().Set(face_vertex_indices)
                        # Triangles
                        num_faces = len(indices) // 3
                        face_vertex_counts = Vt.IntArray([3] * num_faces)
                        usd_mesh.GetFaceVertexCountsAttr().Set(face_vertex_counts)
                    else:
                        num_points = len(positions) if "POSITION" in primitive.attributes.__dict__ else 0
                        num_faces = num_points // 3
                        face_vertex_indices = Vt.IntArray(list(range(num_points)))
                        face_vertex_counts = Vt.IntArray([3] * num_faces)
                        usd_mesh.GetFaceVertexIndicesAttr().Set(face_vertex_indices)
                        usd_mesh.GetFaceVertexCountsAttr().Set(face_vertex_counts)

                    # Subdivision
                    usd_mesh.GetSubdivisionSchemeAttr().Set("none")

                    # Apply transform for non-skinned meshes
                    if not has_skin:
                        world_xform = local_xform * parent_xform if parent_xform else local_xform
                        xformable = UsdGeom.Xformable(usd_mesh.GetPrim())
                        xformable.AddTransformOp().Set(world_xform)

                    # Skinning
                    if has_skin:
                        binding = UsdSkel.BindingAPI.Apply(usd_mesh.GetPrim())
                        binding.CreateSkeletonRel().SetTargets(
                            [Sdf.Path(skel_path)]
                        )

                        # Joint indices
                        if hasattr(primitive.attributes, 'JOINTS_0') and primitive.attributes.JOINTS_0 is not None:
                            joints_data = _accessor_data(
                                gltf, primitive.attributes.JOINTS_0
                            )
                            joint_indices_flat = joints_data.flatten().astype(
                                np.int32
                            )
                            binding.CreateJointIndicesPrimvar(
                                False, 4
                            ).Set(Vt.IntArray(joint_indices_flat.tolist()))

                        # Joint weights
                        if hasattr(primitive.attributes, 'WEIGHTS_0') and primitive.attributes.WEIGHTS_0 is not None:
                            weights_data = _accessor_data(
                                gltf, primitive.attributes.WEIGHTS_0
                            )
                            weights_flat = weights_data.flatten().astype(np.float32)
                            binding.CreateJointWeightsPrimvar(
                                False, 4
                            ).Set(Vt.FloatArray(weights_flat.tolist()))

                        geom_bind = Vt.Matrix4dArray([Gf.Matrix4d(1.0)])
                        binding.CreateGeomBindTransformAttr().Set(
                            Gf.Matrix4d(1.0)
                        )

                    # Material (basic)
                    if primitive.material is not None:
                        mat_idx = primitive.material
                        if mat_idx not in material_map:
                            gltf_mat = gltf.materials[mat_idx]
                            mat_name = _sanitize_name(
                                gltf_mat.name or f"material_{mat_idx}"
                            )
                            mat_path = f"/Root/Materials/{mat_name}"
                            usd_mat = UsdShade.Material.Define(stage, mat_path)

                            shader = UsdShade.Shader.Define(
                                stage, f"{mat_path}/PBRShader"
                            )
                            shader.CreateIdAttr("UsdPreviewSurface")

                            # Base color
                            pbr = gltf_mat.pbrMetallicRoughness
                            if pbr and pbr.baseColorFactor:
                                c = pbr.baseColorFactor
                                shader.CreateInput(
                                    "diffuseColor", Sdf.ValueTypeNames.Color3f
                                ).Set(Gf.Vec3f(c[0], c[1], c[2]))
                                if len(c) > 3 and c[3] < 1.0:
                                    shader.CreateInput(
                                        "opacity", Sdf.ValueTypeNames.Float
                                    ).Set(float(c[3]))

                            # Metallic/roughness
                            if pbr:
                                shader.CreateInput(
                                    "metallic", Sdf.ValueTypeNames.Float
                                ).Set(
                                    float(
                                        pbr.metallicFactor
                                        if pbr.metallicFactor is not None
                                        else 0.0
                                    )
                                )
                                shader.CreateInput(
                                    "roughness", Sdf.ValueTypeNames.Float
                                ).Set(
                                    float(
                                        pbr.roughnessFactor
                                        if pbr.roughnessFactor is not None
                                        else 0.5
                                    )
                                )

                            # Emissive
                            if gltf_mat.emissiveFactor:
                                e = gltf_mat.emissiveFactor
                                shader.CreateInput(
                                    "emissiveColor", Sdf.ValueTypeNames.Color3f
                                ).Set(Gf.Vec3f(e[0], e[1], e[2]))

                            shader.CreateOutput(
                                "surface", Sdf.ValueTypeNames.Token
                            )
                            usd_mat.CreateSurfaceOutput().ConnectToSource(
                                shader.ConnectableAPI(), "surface"
                            )

                            material_map[mat_idx] = mat_path

                        mat_path = material_map[mat_idx]
                        UsdShade.MaterialBindingAPI.Apply(
                            usd_mesh.GetPrim()
                        ).Bind(UsdShade.Material.Get(stage, mat_path))

            # Process children
            if node.children:
                for child_idx in node.children:
                    # Skip joint nodes (already processed as skeleton)
                    is_joint = False
                    for skin in (gltf.skins or []):
                        if child_idx in skin.joints:
                            is_joint = True
                            break
                    if not is_joint:
                        process_node(child_idx, parent_path, local_xform * parent_xform if parent_xform else local_xform)

        # Process scene root nodes
        for node_idx in scene.nodes:
            # Skip nodes that are skeleton roots
            is_joint = False
            for skin in (gltf.skins or []):
                if node_idx in skin.joints:
                    is_joint = True
                    break
            if not is_joint:
                process_node(node_idx, "/Root", Gf.Matrix4d(1.0))

        # Process animations
        fps = 24.0
        stage.SetFramesPerSecond(fps)
        stage.SetTimeCodesPerSecond(fps)

        for anim_idx, animation in enumerate(gltf.animations or []):
            # Group channels by target node
            node_channels = {}
            for channel in animation.channels:
                target_node = channel.target.node
                if target_node not in node_channels:
                    node_channels[target_node] = []
                node_channels[target_node].append(channel)

            # Check which skins these animations affect
            for skin_idx, skin in enumerate(gltf.skins or []):
                if skin_idx not in skeleton_map:
                    continue
                skel_root_path, joint_paths, skel_path = skeleton_map[skin_idx]

                # Check if any animated node is a joint in this skin
                animated_joints = []
                for node_idx in node_channels:
                    if node_idx in skin.joints:
                        animated_joints.append(node_idx)

                if not animated_joints:
                    continue

                anim_name = _sanitize_name(
                    animation.name or f"anim_{anim_idx}"
                )
                anim_path = f"{skel_root_path}/{anim_name}"
                skel_anim = UsdSkel.Animation.Define(stage, anim_path)

                # Collect all time samples across all channels
                all_times = set()
                channel_data = {}
                for node_idx in animated_joints:
                    for channel in node_channels[node_idx]:
                        sampler = animation.samplers[channel.sampler]
                        times = _accessor_data(gltf, sampler.input).flatten()
                        values = _accessor_data(gltf, sampler.output)
                        all_times.update(times.tolist())
                        key = (node_idx, channel.target.path)
                        channel_data[key] = (times, values, sampler.interpolation)

                sorted_times = sorted(all_times)
                if not sorted_times:
                    continue

                # Set animation time range
                start_frame = sorted_times[0] * fps
                end_frame = sorted_times[-1] * fps
                stage.SetStartTimeCode(start_frame)
                stage.SetEndTimeCode(end_frame)

                # Build per-joint animation data for each time sample
                # USD SkelAnimation requires all joints to have values at each time
                skel_anim.GetJointsAttr().Set(joint_paths)

                for time_sec in sorted_times:
                    frame = time_sec * fps

                    trans_list = []
                    rot_list = []
                    scale_list = []

                    for ji, joint_idx in enumerate(skin.joints):
                        node = gltf.nodes[joint_idx]

                        # Default from node
                        t = list(node.translation or [0, 0, 0])
                        r = list(node.rotation or [0, 0, 0, 1])
                        s = list(node.scale or [1, 1, 1])

                        # Override with animation data
                        for path_name, default_val, setter in [
                            ("translation", t, lambda v: v),
                            ("rotation", r, lambda v: v),
                            ("scale", s, lambda v: v),
                        ]:
                            key = (joint_idx, path_name)
                            if key in channel_data:
                                ch_times, ch_values, interp = channel_data[key]

                                # Find interpolated value at this time
                                if time_sec <= ch_times[0]:
                                    val = ch_values[0]
                                elif time_sec >= ch_times[-1]:
                                    val = ch_values[-1]
                                else:
                                    # Linear interpolation between keyframes
                                    idx_right = np.searchsorted(ch_times, time_sec)
                                    idx_left = idx_right - 1
                                    t_left = ch_times[idx_left]
                                    t_right = ch_times[idx_right]
                                    alpha = (
                                        (time_sec - t_left) / (t_right - t_left)
                                        if t_right > t_left
                                        else 0.0
                                    )

                                    if path_name == "rotation":
                                        # SLERP for quaternions
                                        q0 = ch_values[idx_left]
                                        q1 = ch_values[idx_right]
                                        dot = np.dot(q0, q1)
                                        if dot < 0:
                                            q1 = -q1
                                            dot = -dot
                                        if dot > 0.9995:
                                            val = q0 + alpha * (q1 - q0)
                                            val = val / np.linalg.norm(val)
                                        else:
                                            theta = np.arccos(np.clip(dot, -1, 1))
                                            sin_theta = np.sin(theta)
                                            val = (
                                                np.sin((1 - alpha) * theta) / sin_theta * q0
                                                + np.sin(alpha * theta) / sin_theta * q1
                                            )
                                    else:
                                        val = ch_values[idx_left] * (1 - alpha) + ch_values[idx_right] * alpha

                                if path_name == "translation":
                                    t = val.tolist() if hasattr(val, 'tolist') else list(val)
                                elif path_name == "rotation":
                                    r = val.tolist() if hasattr(val, 'tolist') else list(val)
                                elif path_name == "scale":
                                    s = val.tolist() if hasattr(val, 'tolist') else list(val)

                        trans_list.append(Gf.Vec3f(float(t[0]), float(t[1]), float(t[2])))
                        rot_list.append(
                            Gf.Quatf(float(r[3]), float(r[0]), float(r[1]), float(r[2]))
                        )
                        scale_list.append(Gf.Vec3h(float(s[0]), float(s[1]), float(s[2])))

                    skel_anim.GetTranslationsAttr().Set(Vt.Vec3fArray(trans_list), frame)
                    skel_anim.GetRotationsAttr().Set(Vt.QuatfArray(rot_list), frame)
                    skel_anim.GetScalesAttr().Set(Vt.Vec3hArray(scale_list), frame)

                # Bind animation to skeleton
                skel_binding = UsdSkel.BindingAPI.Apply(
                    stage.GetPrimAtPath(skel_root_path)
                )
                skel_binding.CreateAnimationSourceRel().SetTargets(
                    [Sdf.Path(anim_path)]
                )

        stage.Save()

        # Package as USDZ
        UsdUtils.CreateNewUsdzPackage(Sdf.AssetPath(usda_path), output_path)

    print(f"Successfully converted {input_path} -> {output_path}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <input.glb> <output.usdz>", file=sys.stderr)
        sys.exit(1)

    input_glb = sys.argv[1]
    output_usdz = sys.argv[2]

    if not os.path.exists(input_glb):
        print(f"Input file not found: {input_glb}", file=sys.stderr)
        sys.exit(1)

    convert_glb_to_usdz(input_glb, output_usdz)
