#!/usr/bin/env python3
"""Convert HoloIM's self-contained GLB recordings to an animated Quick Look demo.

This is deliberately a PreviewSurface approximation, not a glTF runtime. Custom
browser shaders/lights and optional material extensions have no exact USD
mapping. Required extensions we cannot reproduce are rejected. Quick Look plays the first
clip; capture emits a single RecordedMotion clip.
Dependencies: pip install -r requirements.txt; ffmpeg when audio is present.
"""

import base64
import math
import os
from pathlib import Path
import re
import shutil
import struct
import json
import io
import signal
import subprocess
import sys
import tempfile

import numpy as np
import pygltflib
from PIL import Image
from pxr import Gf, Kind, Sdf, Usd, UsdGeom, UsdMedia, UsdShade, UsdSkel, Vt

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cloche as cloche_rules  # noqa: E402

FPS = 30.0
MAX_INPUT_BYTES = 100 * 1024 * 1024
MAX_VERTICES = 2_000_000
MAX_SAMPLES = 20_000
# Scale written for a hidden (zero-scale) node; see `animate`.
HIDDEN_SCALE = 1e-4
MAX_DURATION = 600
MAX_TEXTURE_PIXELS = 4096 * 4096
MAX_TOTAL_TEXTURE_PIXELS = 64 * 1024 * 1024
MAX_OUTPUT_VERTICES = 4_000_000
Image.MAX_IMAGE_PIXELS = MAX_TEXTURE_PIXELS
SUPPORTED_EXTENSIONS = {"KHR_audio", "KHR_texture_transform", "KHR_materials_unlit", "KHR_materials_emissive_strength"}


def _name(value):
    return re.sub(r"[^a-zA-Z0-9_]", "_", value or "unnamed")


def _buffer_view(gltf, index):
    if not isinstance(index, int) or index < 0 or index >= len(gltf.bufferViews):
        raise ValueError("Invalid buffer view index")
    view = gltf.bufferViews[index]
    if view.buffer != 0 or gltf.buffers[0].uri:
        raise ValueError("Quick Look conversion requires embedded GLB buffers")
    start = view.byteOffset or 0
    if start < 0 or view.byteLength < 0:
        raise ValueError("Invalid buffer view range")
    data = gltf.binary_blob()[start:start + view.byteLength]
    if len(data) != view.byteLength:
        raise ValueError("Truncated GLB buffer view")
    return data


def _accessor_data(gltf, index):
    if not isinstance(index, int) or index < 0 or index >= len(gltf.accessors):
        raise ValueError("Invalid accessor index")
    accessor = gltf.accessors[index]
    dtype = np.dtype({5120: "i1", 5121: "u1", 5122: "<i2", 5123: "<u2", 5125: "<u4", 5126: "<f4"}[accessor.componentType])
    width = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}[accessor.type]
    if not 0 <= accessor.count <= MAX_VERTICES:
        raise ValueError("Accessor count exceeds conversion limit")
    if accessor.type in {"MAT2", "MAT3"} and dtype.itemsize < 4:
        raise ValueError("Packed small-component matrix accessors are unsupported")
    if accessor.bufferView is None:
        values = np.zeros((accessor.count, width), dtype=dtype)
    else:
        view = gltf.bufferViews[accessor.bufferView]
        if view.byteStride and view.byteStride < width * dtype.itemsize:
            raise ValueError("Accessor stride is smaller than an element")
        values = np.ndarray((accessor.count, width), dtype=dtype, buffer=_buffer_view(gltf, accessor.bufferView), offset=accessor.byteOffset or 0, strides=(view.byteStride or width * dtype.itemsize, dtype.itemsize)).copy()
    if accessor.sparse and accessor.sparse.count:
        sparse = accessor.sparse
        idtype = np.dtype({5121: "u1", 5123: "<u2", 5125: "<u4"}[sparse.indices.componentType])
        indices = np.frombuffer(_buffer_view(gltf, sparse.indices.bufferView), dtype=idtype, count=sparse.count, offset=sparse.indices.byteOffset or 0)
        if np.any(indices >= accessor.count) or len(set(indices.tolist())) != len(indices):
            raise ValueError("Invalid sparse accessor indices")
        replacements = np.frombuffer(_buffer_view(gltf, sparse.values.bufferView), dtype=dtype, count=sparse.count * width, offset=sparse.values.byteOffset or 0).reshape(-1, width)
        values[indices] = replacements
    if accessor.normalized and accessor.componentType != 5126:
        limit = np.iinfo(dtype).max
        values = np.maximum(values.astype(np.float32) / limit, -1.0)
    if not np.all(np.isfinite(values)):
        raise ValueError("Accessor contains non-finite values")
    return values[:, 0] if width == 1 else values


def _matrix(flat):
    # glTF column-major storage is already the row-vector USD matrix order.
    if np.asarray(flat).size != 16 or not np.all(np.isfinite(flat)):
        raise ValueError("Invalid node matrix")
    return Gf.Matrix4d(*[float(v) for v in np.asarray(flat).reshape(-1)])


def _trs(t, r, s):
    if len(t) != 3 or len(r) != 4 or len(s) != 3 or not all(np.all(np.isfinite(v)) for v in (t, r, s)):
        raise ValueError("Invalid node transform")
    scale = Gf.Matrix4d(1).SetScale(Gf.Vec3d(*map(float, s)))
    rotation = Gf.Matrix4d(1).SetRotate(Gf.Quatd(float(r[3]), Gf.Vec3d(*map(float, r[:3]))))
    translation = Gf.Matrix4d(1).SetTranslate(Gf.Vec3d(*map(float, t)))
    return scale * rotation * translation


def _node_trs(node):
    if node.matrix:
        transform = Gf.Transform(_matrix(node.matrix))
        quat = transform.GetRotation().GetQuat()
        return list(transform.GetTranslation()), [*quat.GetImaginary(), quat.GetReal()], list(transform.GetScale())
    return node.translation or [0, 0, 0], node.rotation or [0, 0, 0, 1], node.scale or [1, 1, 1]


def _local(node):
    return _matrix(node.matrix) if node.matrix else _trs(*_node_trs(node))


def _quat(values):
    values = np.asarray(values, dtype=float)
    if not np.all(np.isfinite(values)) or np.linalg.norm(values) < 1e-8:
        raise ValueError("Invalid rotation quaternion")
    values /= np.linalg.norm(values)
    return Gf.Quatf(float(values[3]), Gf.Vec3f(*map(float, values[:3])))


def _sample(times, values, interpolation, time, rotation=False):
    if interpolation == "CUBICSPLINE":
        values = values.reshape(len(times), 3, -1)
    if time <= times[0]:
        result = values[0, 1] if interpolation == "CUBICSPLINE" else values[0]
    elif time >= times[-1]:
        result = values[-1, 1] if interpolation == "CUBICSPLINE" else values[-1]
    else:
        right = int(np.searchsorted(times, time, side="right"))
        left = right - 1
        dt = times[right] - times[left]
        a = (time - times[left]) / dt
        if interpolation == "STEP":
            result = values[left]
        elif interpolation == "CUBICSPLINE":
            result = (2*a**3 - 3*a**2 + 1)*values[left, 1] + (a**3 - 2*a**2 + a)*dt*values[left, 2] + (-2*a**3 + 3*a**2)*values[right, 1] + (a**3 - a**2)*dt*values[right, 0]
        elif rotation:
            q0, q1 = values[left], values[right]
            dot = np.dot(q0, q1)
            if dot < 0:
                q1, dot = -q1, -dot
            if dot > 0.9995:
                result = q0 + a*(q1-q0)
            else:
                theta = np.arccos(np.clip(dot, -1, 1))
                result = (np.sin((1-a)*theta)*q0 + np.sin(a*theta)*q1) / np.sin(theta)
        else:
            result = values[left]*(1-a) + values[right]*a
    if rotation:
        result = result / np.linalg.norm(result)
    return result


class Converter:
    def __init__(self, gltf, stage, directory):
        self.gltf, self.stage, self.directory = gltf, stage, directory
        self.parents = {}
        for index, node in enumerate(gltf.nodes):
            for child in node.children or []:
                if child < 0 or child >= len(gltf.nodes):
                    raise ValueError("Invalid child node")
                if child in self.parents:
                    raise ValueError("Node has multiple parents")
                self.parents[child] = index
        for index in range(len(gltf.nodes)):
            seen = set()
            ancestor = index
            while ancestor in self.parents:
                if ancestor in seen or len(seen) > 256:
                    raise ValueError("Cyclic or excessively deep node hierarchy")
                seen.add(ancestor)
                ancestor = self.parents[ancestor]
        self.texture_pixels = 0
        self.vertex_count = 0
        self.paths, self.ops, self.worlds, self.materials, self.images = {}, {}, {}, {}, {}
        self.skins, self.morphs = {}, {}
        self.skin_spaces = {}
        self.animated = set()
        self.bubble_index = next((i for i, n in enumerate(gltf.nodes) if n.name == "RecordedBubbleSphere"), None)
        self.bubble_center = None
        self.bubble_radius = None
        self.clips = []
        offset = 0.0
        for animation in (gltf.animations or [])[:1]:
            if len(animation.channels) > 2048:
                raise ValueError("Animation exceeds channel limit")
            channels, last = {}, 0.0
            for channel in animation.channels:
                node, path = channel.target.node, channel.target.path
                if node is None or path not in {"translation", "rotation", "scale", "weights"}:
                    raise ValueError("Unsupported animation target")
                sampler = animation.samplers[channel.sampler]
                times = _accessor_data(gltf, sampler.input)
                if len(times) == 0 or not np.all(np.isfinite(times)) or np.any(np.diff(times) <= 0):
                    raise ValueError("Animation times must be finite and strictly increasing")
                if times[0] < 0 or times[-1] > MAX_DURATION or len(times) > MAX_SAMPLES:
                    raise ValueError("Animation exceeds duration/sample limit")
                values = _accessor_data(gltf, sampler.output)
                interp = sampler.interpolation or "LINEAR"
                if interp not in {"LINEAR", "STEP", "CUBICSPLINE"}:
                    raise ValueError(f"Unsupported animation interpolation: {interp}")
                divisor = len(times) * (3 if interp == "CUBICSPLINE" else 1)
                values = values.reshape(divisor, -1)
                last = max(last, float(times[-1]))
                if node == self.bubble_index and path in {"translation", "rotation", "scale"}:
                    # WebXR AR pins the recorded diorama while the performer moves.
                    # The export's rest transform can be the LAST recorded pose.
                    # Pin at the first animated pose, not at that export-time pose.
                    pinned = gltf.nodes[node]
                    t, r, s = _node_trs(pinned)
                    pinned.translation, pinned.rotation, pinned.scale = t, r, s
                    pinned.matrix = None
                    setattr(pinned, path, _sample(times, values, interp, 0, rotation=path == "rotation").tolist())
                    continue
                channels[node, path] = (times, values, interp)
                self.animated.add(node)
            self.clips.append((offset, last, channels))
            offset += last + 1/FPS
        self.duration = max(0.0, offset - 1/FPS)
        if self.bubble_index is not None:
            bubble = gltf.nodes[self.bubble_index]
            if bubble.mesh is not None:
                primitive = gltf.meshes[bubble.mesh].primitives[0]
                positions = _accessor_data(gltf, primitive.attributes.POSITION)
                world = self.world(self.bubble_index)
                self.bubble_center = np.array(world.Transform(Gf.Vec3d(0)))
                scale = max(abs(v) for v in Gf.Transform(world).GetScale())
                self.bubble_radius = float(np.linalg.norm(positions, axis=1).max()) * scale
                if not 0 < self.bubble_radius <= 100:
                    raise ValueError("Invalid diorama radius")
        stage.SetStartTimeCode(0)
        stage.SetEndTimeCode(max(1, self.duration * FPS))
        stage.SetFramesPerSecond(FPS)
        stage.SetTimeCodesPerSecond(FPS)

    def world(self, index):
        if index not in self.worlds:
            self.worlds[index] = _local(self.gltf.nodes[index]) * (self.world(self.parents[index]) if index in self.parents else Gf.Matrix4d(1))
        return self.worlds[index]

    def node(self, index, parent):
        node = self.gltf.nodes[index]
        path = f"{parent}/n{index}_{_name(node.name)}"
        self.paths[index] = path
        xform = UsdGeom.Xform.Define(self.stage, path)
        xform.GetPrim().SetCustomDataByKey("gltfNodeIndex", index)
        if node.matrix and index not in self.animated:
            xform.AddTransformOp().Set(_matrix(node.matrix))
        else:
            t, r, s = _node_trs(node)
            ops = (xform.AddTranslateOp(), xform.AddOrientOp(UsdGeom.XformOp.PrecisionFloat), xform.AddScaleOp())
            ops[0].Set(Gf.Vec3d(*map(float, t)))
            ops[1].Set(_quat(r))
            ops[2].Set(Gf.Vec3d(*map(float, s)))
            self.ops[index] = ops
        if node.mesh is not None:
            # glTF skinning ignores a skinned node's own transform; joint world
            # matrices and inverseBindMatrices already produce scene positions.
            mesh_parent = f"/Root/Skinned_n{index}" if node.skin is not None else path
            if node.skin is not None:
                UsdGeom.Xform.Define(self.stage, mesh_parent)
            for primitive_index, primitive in enumerate(self.gltf.meshes[node.mesh].primitives):
                self.mesh(index, primitive_index, primitive, mesh_parent)
        for child in node.children or []:
            self.node(child, path)

    def skeletons(self):
        equivalent = {}
        for skin_index, skin in enumerate(self.gltf.skins or []):
            if not skin.joints or len(set(skin.joints)) != len(skin.joints):
                raise ValueError("Skin joints must be nonempty and unique")
            inverse = _accessor_data(self.gltf, skin.inverseBindMatrices) if skin.inverseBindMatrices is not None else np.tile(np.eye(4, dtype=np.float32).reshape(1, 16), (len(skin.joints), 1))
            if inverse.shape != (len(skin.joints), 16):
                raise ValueError("Inverse bind matrices do not match skin joints")
            key = (tuple(skin.joints), inverse.tobytes())
            if key in equivalent:
                original = equivalent[key]
                self.skins[skin_index] = self.skins[original]
                self.skin_spaces[skin_index] = self.skin_spaces[original]
                continue
            equivalent[key] = skin_index
            def ancestors(index):
                chain = [index]
                while index in self.parents:
                    index = self.parents[index]
                    chain.append(index)
                return chain
            chains = [ancestors(joint) for joint in skin.joints]
            common = set.intersection(*(set(chain) for chain in chains))
            top = next((index for index in chains[0] if index in common), None)
            # Keep shared external ancestors in a full-precision Xform. USD
            # skeleton animation scales are half3: rounding an ancestor scale
            # before a large root translation can otherwise move the avatar.
            space_parent = self.parents.get(top) if top is not None else None
            space_world = self.world(space_parent) if space_parent is not None else Gf.Matrix4d(1)
            space_inverse = space_world.GetInverse()
            included = set(skin.joints)
            for joint in skin.joints:
                if joint == top:
                    continue
                ancestor = self.parents.get(joint)
                while ancestor is not None:
                    if ancestor in included:
                        break
                    included.add(ancestor)
                    if ancestor == top:
                        break
                    ancestor = self.parents.get(ancestor)
            ordered, paths = [], {}
            def add(index):
                if index in paths:
                    return
                parent = self.parents.get(index)
                if parent in included:
                    add(parent)
                paths[index] = f"{paths[parent]}/j{index}" if parent in included else f"j{index}"
                ordered.append(index)
            for index in sorted(included):
                add(index)
            space = UsdGeom.Xform.Define(self.stage, f"/Root/SkeletonSpace_{skin_index}")
            space_op = space.AddTransformOp()
            space_op.Set(space_world)
            self.skin_spaces[skin_index] = (space_parent, space_op, space_inverse)
            skeleton = UsdSkel.Skeleton.Define(self.stage, f"{space.GetPath()}/Skeleton")
            skeleton.GetPrim().SetCustomDataByKey("gltfSkinIndex", skin_index)
            skeleton.GetPrim().SetCustomDataByKey("gltfJointNodeIndices", Vt.IntArray(ordered))
            skeleton.CreateJointsAttr().Set([paths[index] for index in ordered])
            if skin.inverseBindMatrices is not None:
                binds = {joint: _matrix(inverse[i]).GetInverse() for i, joint in enumerate(skin.joints)}
            else:
                # glTF explicitly defaults missing inverse bind matrices to identity.
                binds = {joint: Gf.Matrix4d(1) for joint in skin.joints}
            skeleton.CreateBindTransformsAttr().Set(Vt.Matrix4dArray([binds.get(index, self.world(index)) * space_inverse for index in ordered]))
            skeleton.CreateRestTransformsAttr().Set(Vt.Matrix4dArray([_local(self.gltf.nodes[index]) for index in ordered]))
            remap = np.array([ordered.index(joint) for joint in skin.joints])
            self.skins[skin_index] = (skeleton, ordered, remap)

    def image(self, index):
        if index in self.images:
            return self.images[index]
        image = self.gltf.images[index]
        if image.bufferView is not None:
            data = _buffer_view(self.gltf, image.bufferView)
        elif image.uri and image.uri.startswith("data:"):
            data = base64.b64decode(image.uri.split(",", 1)[1], validate=True)
        else:
            raise ValueError("Quick Look conversion requires embedded images")
        suffix = ".png" if data.startswith(b"\x89PNG") else ".jpg" if data.startswith(b"\xff\xd8") else None
        if not suffix:
            raise ValueError("Quick Look textures must be PNG or JPEG")
        with Image.open(io.BytesIO(data)) as decoded:
            pixels = decoded.width * decoded.height
            if pixels > MAX_TEXTURE_PIXELS:
                raise ValueError("Texture exceeds pixel limit")
            self.texture_pixels += pixels
            if self.texture_pixels > MAX_TOTAL_TEXTURE_PIXELS:
                raise ValueError("Total textures exceed pixel limit")
            decoded.verify()
        relative = f"textures/image_{index}{suffix}"
        target = Path(self.directory, relative)
        target.parent.mkdir(exist_ok=True)
        target.write_bytes(data)
        self.images[index] = relative
        return relative

    def texture(self, info, parent, name, srgb=False, scale=(1, 1, 1, 1), bias=(0, 0, 0, 0)):
        texture = self.gltf.textures[info.index]
        if texture.source is None:
            raise ValueError("Texture has no supported image source")
        shader = UsdShade.Shader.Define(self.stage, f"{parent}/{name}")
        shader.CreateIdAttr("UsdUVTexture")
        shader.CreateInput("file", Sdf.ValueTypeNames.Asset).Set(Sdf.AssetPath(self.image(texture.source)))
        shader.CreateInput("sourceColorSpace", Sdf.ValueTypeNames.Token).Set("sRGB" if srgb else "raw")
        # RealityKit only honors UsdUVTexture scale/bias for normal maps. Bake
        # other factors into pixels in linear light, retaining PNG/JPEG detail.
        if name != "Normal" and (tuple(scale) != (1, 1, 1, 1) or tuple(bias) != (0, 0, 0, 0)):
            image = Image.open(Path(self.directory, self.image(texture.source))).convert("RGBA")
            pixels = np.array(image, dtype=np.float32) / 255
            if srgb:
                rgb = pixels[:, :, :3]
                pixels[:, :, :3] = np.where(rgb <= 0.04045, rgb/12.92, ((rgb+0.055)/1.055)**2.4)
            pixels = pixels * np.asarray(scale, dtype=np.float32) + np.asarray(bias, dtype=np.float32)
            if srgb:
                rgb = np.maximum(pixels[:, :, :3], 0)
                pixels[:, :, :3] = np.where(rgb <= 0.0031308, rgb*12.92, 1.055*rgb**(1/2.4)-0.055)
            relative = f"textures/{Path(parent).name}_{name}.png"
            Image.fromarray(np.round(np.clip(pixels, 0, 1)*255).astype(np.uint8)).save(Path(self.directory, relative))
            shader.GetInput("file").Set(Sdf.AssetPath(relative))
            scale, bias = (1, 1, 1, 1), (0, 0, 0, 0)
        shader.CreateInput("scale", Sdf.ValueTypeNames.Float4).Set(Gf.Vec4f(*scale))
        shader.CreateInput("bias", Sdf.ValueTypeNames.Float4).Set(Gf.Vec4f(*bias))
        sampler = self.gltf.samplers[texture.sampler] if texture.sampler is not None else None
        wraps = {33071: "clamp", 33648: "mirror", 10497: "repeat"}
        shader.CreateInput("wrapS", Sdf.ValueTypeNames.Token).Set(wraps.get(sampler.wrapS if sampler else None, "repeat"))
        shader.CreateInput("wrapT", Sdf.ValueTypeNames.Token).Set(wraps.get(sampler.wrapT if sampler else None, "repeat"))
        transform = (info.extensions or {}).get("KHR_texture_transform", {})
        uv = transform.get("texCoord", info.texCoord or 0)
        reader = UsdShade.Shader.Define(self.stage, f"{parent}/{name}_UV")
        reader.CreateIdAttr("UsdPrimvarReader_float2")
        reader.CreateInput("varname", Sdf.ValueTypeNames.String).Set("st" if uv == 0 else f"st{uv}")
        reader.CreateOutput("result", Sdf.ValueTypeNames.Float2)
        source = reader
        if transform:
            st = UsdShade.Shader.Define(self.stage, f"{parent}/{name}_Transform")
            st.CreateIdAttr("UsdTransform2d")
            st.CreateInput("in", Sdf.ValueTypeNames.Float2).ConnectToSource(reader.ConnectableAPI(), "result")
            sx, sy = transform.get("scale", [1, 1])
            ox, oy = transform.get("offset", [0, 0])
            angle = transform.get("rotation", 0)
            st.CreateInput("scale", Sdf.ValueTypeNames.Float2).Set(Gf.Vec2f(sx, sy))
            st.CreateInput("rotation", Sdf.ValueTypeNames.Float).Set(-math.degrees(angle))
            st.CreateInput("translation", Sdf.ValueTypeNames.Float2).Set(Gf.Vec2f(ox - math.sin(angle)*sy, 1-oy-math.cos(angle)*sy))
            st.CreateOutput("result", Sdf.ValueTypeNames.Float2)
            source = st
        shader.CreateInput("st", Sdf.ValueTypeNames.Float2).ConnectToSource(source.ConnectableAPI(), "result")
        for channel in ["r", "g", "b", "a"]:
            shader.CreateOutput(channel, Sdf.ValueTypeNames.Float)
        shader.CreateOutput("rgb", Sdf.ValueTypeNames.Float3)
        return shader

    def material(self, index):
        if index in self.materials:
            return self.materials[index]
        material = self.gltf.materials[index]
        path = f"/Root/Materials/m{index}_{_name(material.name)}"
        result = UsdShade.Material.Define(self.stage, path)
        result.GetPrim().SetCustomDataByKey("gltfMaterialIndex", index)
        shader = UsdShade.Shader.Define(self.stage, path + "/Surface")
        shader.CreateIdAttr("UsdPreviewSurface")
        pbr = material.pbrMetallicRoughness
        color = pbr.baseColorFactor if pbr and pbr.baseColorFactor else [1, 1, 1, 1]
        unlit = "KHR_materials_unlit" in (material.extensions or {})
        shader.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(*color[:3]))
        shader.CreateInput("metallic", Sdf.ValueTypeNames.Float).Set(0.0 if unlit else float(pbr.metallicFactor if pbr and pbr.metallicFactor is not None else 1))
        shader.CreateInput("roughness", Sdf.ValueTypeNames.Float).Set(1.0 if unlit else float(pbr.roughnessFactor if pbr and pbr.roughnessFactor is not None else 1))
        if pbr and pbr.baseColorTexture:
            texture = self.texture(pbr.baseColorTexture, path, "BaseColor", True, tuple(color))
            shader.GetInput("diffuseColor").ConnectToSource(texture.ConnectableAPI(), "rgb")
            if material.alphaMode in {"BLEND", "MASK"}:
                shader.CreateInput("opacity", Sdf.ValueTypeNames.Float).ConnectToSource(texture.ConnectableAPI(), "a")
        elif material.alphaMode in {"BLEND", "MASK"}:
            shader.CreateInput("opacity", Sdf.ValueTypeNames.Float).Set(float(color[3]))
        if material.alphaMode == "MASK":
            shader.CreateInput("opacityThreshold", Sdf.ValueTypeNames.Float).Set(float(material.alphaCutoff if material.alphaCutoff is not None else 0.5))
        if pbr and pbr.metallicRoughnessTexture and not unlit:
            roughness = pbr.roughnessFactor if pbr.roughnessFactor is not None else 1
            metallic = pbr.metallicFactor if pbr.metallicFactor is not None else 1
            texture = self.texture(pbr.metallicRoughnessTexture, path, "MetalRough", scale=(1, roughness, metallic, 1))
            shader.GetInput("roughness").ConnectToSource(texture.ConnectableAPI(), "g")
            shader.GetInput("metallic").ConnectToSource(texture.ConnectableAPI(), "b")
        if material.normalTexture and not unlit:
            strength = material.normalTexture.scale if material.normalTexture.scale is not None else 1
            texture = self.texture(material.normalTexture, path, "Normal", scale=(2*strength, 2*strength, 2, 1), bias=(-strength, -strength, -1, 0))
            shader.CreateInput("normal", Sdf.ValueTypeNames.Normal3f).ConnectToSource(texture.ConnectableAPI(), "rgb")
        emission = list(material.emissiveFactor or [0, 0, 0])
        strength = (material.extensions or {}).get("KHR_materials_emissive_strength", {}).get("emissiveStrength", 1)
        emission = [v * strength for v in emission]
        if unlit:
            emission = color[:3]
            shader.GetInput("diffuseColor").Set(Gf.Vec3f(0))
        shader.CreateInput("emissiveColor", Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(*emission))
        if unlit and pbr and pbr.baseColorTexture:
            shader.GetInput("emissiveColor").ConnectToSource(UsdShade.Shader.Get(self.stage, path + "/BaseColor").ConnectableAPI(), "rgb")
            shader.GetInput("diffuseColor").Set(Gf.Vec3f(0))
            shader.GetInput("diffuseColor").DisconnectSource()
        elif material.emissiveTexture:
            texture = self.texture(material.emissiveTexture, path, "Emissive", True, (*emission, 1))
            shader.GetInput("emissiveColor").ConnectToSource(texture.ConnectableAPI(), "rgb")
        if material.occlusionTexture and not unlit:
            strength = material.occlusionTexture.strength if material.occlusionTexture.strength is not None else 1
            texture = self.texture(material.occlusionTexture, path, "Occlusion", scale=(strength, 1, 1, 1), bias=(1-strength, 0, 0, 0))
            shader.CreateInput("occlusion", Sdf.ValueTypeNames.Float).ConnectToSource(texture.ConnectableAPI(), "r")
        shader.CreateOutput("surface", Sdf.ValueTypeNames.Token)
        result.CreateSurfaceOutput().ConnectToSource(shader.ConnectableAPI(), "surface")
        self.materials[index] = result
        return result

    def mesh(self, node_index, primitive_index, primitive, parent):
        if primitive.mode not in (None, 4):
            raise ValueError("Quick Look conversion supports triangle meshes only")
        attrs = primitive.attributes
        if attrs.POSITION is None:
            raise ValueError("Mesh has no positions")
        points = _accessor_data(self.gltf, attrs.POSITION)
        self.vertex_count += len(points)
        if self.vertex_count > MAX_VERTICES:
            raise ValueError("Scene exceeds vertex limit")
        indices = _accessor_data(self.gltf, primitive.indices).astype(int).reshape(-1) if primitive.indices is not None else np.arange(len(points))
        if len(indices) % 3 or np.any(indices < 0) or np.any(indices >= len(points)):
            raise ValueError("Invalid triangle indices")
        mesh = UsdGeom.Mesh.Define(self.stage, f"{parent}/primitive_{primitive_index}")
        mesh.GetPrim().SetCustomDataByKey("gltfNodeIndex", node_index)
        mesh.GetPrim().SetCustomDataByKey("gltfPrimitiveIndex", primitive_index)
        mesh.CreatePointsAttr().Set(Vt.Vec3fArray.FromNumpy(points.astype(np.float32)))
        mesh.CreateFaceVertexIndicesAttr().Set(Vt.IntArray(indices.tolist()))
        mesh.CreateFaceVertexCountsAttr().Set(Vt.IntArray([3]*(len(indices)//3)))
        mesh.CreateSubdivisionSchemeAttr().Set("none")
        if attrs.NORMAL is not None:
            mesh.CreateNormalsAttr().Set(Vt.Vec3fArray.FromNumpy(_accessor_data(self.gltf, attrs.NORMAL).astype(np.float32)))
            mesh.SetNormalsInterpolation("vertex")
        primvars = UsdGeom.PrimvarsAPI(mesh)
        for key, value in attrs.__dict__.items():
            if key.startswith("TEXCOORD_") and value is not None:
                uv = _accessor_data(self.gltf, value).astype(np.float32)
                uv[:, 1] = 1 - uv[:, 1]
                number = int(key.split("_")[-1])
                primvars.CreatePrimvar("st" if number == 0 else f"st{number}", Sdf.ValueTypeNames.TexCoord2fArray, "vertex").Set(Vt.Vec2fArray.FromNumpy(uv))
        if primitive.material is not None:
            UsdShade.MaterialBindingAPI.Apply(mesh.GetPrim()).Bind(self.material(primitive.material))
            mesh.CreateDoubleSidedAttr().Set(bool(self.gltf.materials[primitive.material].doubleSided))
        if node_index == self.bubble_index:
            # A subtle, fixed matte-blue shell replaces the browser's view/time
            # dependent shader. Static scenery is separately trimmed below.
            material = UsdShade.Material.Define(self.stage, "/Root/Materials/QuickLookBubble")
            surface = UsdShade.Shader.Define(self.stage, "/Root/Materials/QuickLookBubble/Surface")
            surface.CreateIdAttr("UsdPreviewSurface")
            for name, kind, value in [("diffuseColor", Sdf.ValueTypeNames.Color3f, Gf.Vec3f(0.08, 0.5, 0.9)), ("emissiveColor", Sdf.ValueTypeNames.Color3f, Gf.Vec3f(0.015, 0.05, 0.08)), ("metallic", Sdf.ValueTypeNames.Float, 0.0), ("roughness", Sdf.ValueTypeNames.Float, 1.0), ("useSpecularWorkflow", Sdf.ValueTypeNames.Int, 1), ("specularColor", Sdf.ValueTypeNames.Color3f, Gf.Vec3f(0)), ("opacity", Sdf.ValueTypeNames.Float, 0.035)]:
                surface.CreateInput(name, kind).Set(value)
            surface.CreateOutput("surface", Sdf.ValueTypeNames.Token)
            material.CreateSurfaceOutput().ConnectToSource(surface.ConnectableAPI(), "surface")
            UsdShade.MaterialBindingAPI.Apply(mesh.GetPrim()).Bind(material)
            mesh.CreateDoubleSidedAttr().Set(True)
            mesh.GetPrim().SetCustomDataByKey("quickLookPinnedBubble", True)
        node = self.gltf.nodes[node_index]
        binding = None
        if node.skin is not None:
            skeleton, _, remap = self.skins[node.skin]
            if attrs.JOINTS_0 is None or attrs.WEIGHTS_0 is None:
                raise ValueError("Skinned mesh has no joints/weights")
            if (getattr(attrs, "JOINTS_1", None) is None) != (getattr(attrs, "WEIGHTS_1", None) is None):
                raise ValueError("Secondary joints and weights must be paired")
            joint_data = _accessor_data(self.gltf, attrs.JOINTS_0).astype(int)
            weights = _accessor_data(self.gltf, attrs.WEIGHTS_0).astype(np.float32)
            if getattr(attrs, "JOINTS_1", None) is not None:
                joint_data = np.concatenate([joint_data, _accessor_data(self.gltf, attrs.JOINTS_1).astype(int)], axis=1)
                weights = np.concatenate([weights, _accessor_data(self.gltf, attrs.WEIGHTS_1)], axis=1)
            if np.any(joint_data < 0) or np.any(joint_data >= len(remap)) or np.any(weights < 0):
                raise ValueError("Invalid skin joints/weights")
            totals = weights.sum(axis=1)
            if np.any(totals <= 0):
                raise ValueError("Skinned vertex has zero total weight")
            weights /= totals[:, None]
            binding = UsdSkel.BindingAPI.Apply(mesh.GetPrim())
            binding.CreateSkeletonRel().SetTargets([skeleton.GetPath()])
            binding.CreateGeomBindTransformAttr().Set(self.skin_spaces[node.skin][2])
            binding.CreateJointIndicesPrimvar(False, joint_data.shape[1]).Set(Vt.IntArray(remap[joint_data].reshape(-1).tolist()))
            binding.CreateJointWeightsPrimvar(False, weights.shape[1]).Set(Vt.FloatArray(weights.reshape(-1).tolist()))
        if primitive.targets:
            binding = binding or UsdSkel.BindingAPI.Apply(mesh.GetPrim())
            names, targets = [], []
            for index, target in enumerate(primitive.targets):
                target = target if isinstance(target, dict) else target.__dict__
                blend = UsdSkel.BlendShape.Define(self.stage, f"{mesh.GetPath()}/Blend_{index}")
                offsets = _accessor_data(self.gltf, target["POSITION"]) if target.get("POSITION") is not None else np.zeros_like(points)
                blend.CreateOffsetsAttr().Set(Vt.Vec3fArray.FromNumpy(offsets.astype(np.float32)))
                if target.get("NORMAL") is not None:
                    blend.CreateNormalOffsetsAttr().Set(Vt.Vec3fArray.FromNumpy(_accessor_data(self.gltf, target["NORMAL"]).astype(np.float32)))
                names.append(f"n{node_index}_blend{index}")
                targets.append(blend.GetPath())
            binding.CreateBlendShapesAttr().Set(names)
            binding.CreateBlendShapeTargetsRel().SetTargets(targets)
            self.morphs[node_index] = (names, getattr(node, "weights", None) or self.gltf.meshes[node.mesh].weights or [0.0]*len(names))
            if node.skin is None:
                binding.CreateAnimationSourceRel().SetTargets([Sdf.Path("/Root/MorphAnimation")])
        extent = UsdGeom.PointBased(mesh).ComputeExtent(mesh.GetPointsAttr().Get())
        mesh.CreateExtentAttr().Set(extent)

    def finish_geometry(self):
        # The WebXR shader clips the sampled environment to a pinned sphere.
        # USD has no equivalent shader hook. Clip static scene triangles once,
        # interpolating normals/UVs along the boundary. Tangent planes give a
        # small polygonal approximation; projection guarantees no outward leak.
        count = 128
        golden = math.pi * (3 - math.sqrt(5))
        planes = []
        for index in range(count):
            y = 1 - 2*(index + 0.5)/count
            radial = math.sqrt(1-y*y)
            planes.append(np.array([math.cos(index*golden)*radial, y, math.sin(index*golden)*radial]))
        for prim in list(self.stage.Traverse()):
            if not prim.IsA(UsdGeom.Mesh):
                continue
            mesh = UsdGeom.Mesh(prim)
            node_index = prim.GetCustomDataByKey("gltfNodeIndex")
            ancestor, environment = node_index, False
            while ancestor is not None:
                if self.gltf.nodes[ancestor].name == "RecordedSceneBubble":
                    environment = True
                    break
                ancestor = self.parents.get(ancestor)
            if environment and self.bubble_center is not None:
                points = np.asarray(mesh.GetPointsAttr().Get(), dtype=float)
                world = self.world(node_index)
                inverse = world.GetInverse()
                world_points = np.array([world.Transform(Gf.Vec3d(*point)) for point in points])
                relative = world_points - self.bubble_center
                normals = mesh.GetNormalsAttr().Get()
                uv_vars = [uv for uv in UsdGeom.PrimvarsAPI(mesh).GetPrimvars() if uv.GetPrimvarName().startswith("st") and uv.Get() is not None]
                columns, widths = [relative], [3]
                if normals:
                    columns.append(np.asarray(normals)); widths.append(3)
                for uv in uv_vars:
                    columns.append(np.asarray(uv.Get())); widths.append(2)
                vertices = np.concatenate(columns, axis=1)
                output = []
                radius = self.bubble_radius
                faces = np.asarray(mesh.GetFaceVertexIndicesAttr().Get()).reshape(-1, 3)
                for face in faces:
                    polygon = vertices[face]
                    if np.all(np.linalg.norm(polygon[:, :3], axis=1) <= radius):
                        output.extend(polygon)
                        continue
                    closest = np.maximum(np.minimum(0, polygon[:, :3].max(axis=0)), polygon[:, :3].min(axis=0))
                    if np.linalg.norm(closest) > radius:
                        continue
                    for normal in planes:
                        distances = polygon[:, :3] @ normal - radius
                        if np.all(distances <= 0):
                            continue
                        clipped = []
                        for i, current in enumerate(polygon):
                            previous = polygon[i-1]
                            dc, dp = distances[i], distances[i-1]
                            if (dc <= 0) != (dp <= 0):
                                clipped.append(previous + (current-previous)*(dp/(dp-dc)))
                            if dc <= 0:
                                clipped.append(current)
                        if len(clipped) < 3:
                            polygon = np.empty((0, vertices.shape[1]))
                            break
                        polygon = np.asarray(clipped)
                    for i in range(1, len(polygon)-1):
                        output.extend([polygon[0].copy(), polygon[i].copy(), polygon[i+1].copy()])
                    if len(output) > MAX_OUTPUT_VERTICES:
                        raise ValueError("Diorama clipping exceeds output vertex limit")
                if output:
                    output = np.asarray(output)
                    lengths = np.linalg.norm(output[:, :3], axis=1)
                    output[:, :3] *= np.minimum(1, radius/np.maximum(lengths, 1e-12))[:, None]
                    local_points = np.array([inverse.Transform(Gf.Vec3d(*(point + self.bubble_center))) for point in output[:, :3]])
                    mesh.GetPointsAttr().Set(Vt.Vec3fArray.FromNumpy(local_points.astype(np.float32)))
                    cursor = 3
                    if normals:
                        normal_values = output[:, cursor:cursor+3]
                        normal_values /= np.maximum(np.linalg.norm(normal_values, axis=1), 1e-12)[:, None]
                        mesh.GetNormalsAttr().Set(Vt.Vec3fArray.FromNumpy(normal_values.astype(np.float32)))
                        cursor += 3
                    for uv in uv_vars:
                        uv.Set(Vt.Vec2fArray.FromNumpy(output[:, cursor:cursor+2].astype(np.float32)))
                        cursor += 2
                    mesh.GetFaceVertexIndicesAttr().Set(Vt.IntArray(list(range(len(output)))))
                    mesh.GetFaceVertexCountsAttr().Set(Vt.IntArray([3]*(len(output)//3)))
                else:
                    mesh.GetPointsAttr().Set(Vt.Vec3fArray())
                    mesh.GetFaceVertexIndicesAttr().Set(Vt.IntArray())
                    mesh.GetFaceVertexCountsAttr().Set(Vt.IntArray())
                    if normals:
                        mesh.GetNormalsAttr().Set(Vt.Vec3fArray())
                    for uv in uv_vars:
                        uv.Set(Vt.Vec2fArray())
                    mesh.CreateVisibilityAttr().Set("invisible")
                prim.SetCustomDataByKey("quickLookClippedEnvironment", True)
                mesh.GetExtentAttr().Set(mesh.ComputeExtent(mesh.GetPointsAttr().Get()))
            # RealityKit ignores USD doubleSided. Explicit reversed geometry
            # preserves hair cards, scene walls, and the shell viewed from inside.
            if mesh.GetDoubleSidedAttr().Get() and len(mesh.GetPointsAttr().Get()):
                back = UsdGeom.Mesh.Define(self.stage, str(mesh.GetPath()) + "_back")
                back.GetPrim().GetReferences().AddInternalReference(mesh.GetPath())
                back.GetPrim().SetCustomDataByKey("quickLookBackFaces", True)
                indices = np.asarray(mesh.GetFaceVertexIndicesAttr().Get()).reshape(-1, 3)[:, ::-1].reshape(-1)
                back.GetFaceVertexIndicesAttr().Set(Vt.IntArray(indices.tolist()))
                normals = mesh.GetNormalsAttr().Get()
                if normals:
                    back.GetNormalsAttr().Set(Vt.Vec3fArray.FromNumpy(-np.asarray(normals, dtype=np.float32)))
                back.GetDoubleSidedAttr().Set(False)
                mesh.GetDoubleSidedAttr().Set(False)
                for child in back.GetPrim().GetChildren():
                    if child.IsA(UsdSkel.BlendShape):
                        blend = UsdSkel.BlendShape(child)
                        normal_offsets = blend.GetNormalOffsetsAttr().Get()
                        if normal_offsets:
                            blend.GetNormalOffsetsAttr().Set(Vt.Vec3fArray.FromNumpy(-np.asarray(normal_offsets, dtype=np.float32)))

    def animate(self):
        morph_names = [name for names, _ in self.morphs.values() for name in names]
        defaults = [value for _, values in self.morphs.values() for value in values]
        animations = []
        animated_skeletons = set()
        for skin_index, (skeleton, ordered, _) in self.skins.items():
            if skeleton.GetPath() in animated_skeletons:
                continue
            animated_skeletons.add(skeleton.GetPath())
            animation = UsdSkel.Animation.Define(self.stage, f"/Root/Animation_{skin_index}")
            animation.CreateJointsAttr().Set(skeleton.GetJointsAttr().Get())
            UsdSkel.BindingAPI.Apply(skeleton.GetPrim()).CreateAnimationSourceRel().SetTargets([animation.GetPath()])
            animations.append((animation, ordered))
        if morph_names:
            morph_animation = UsdSkel.Animation.Define(self.stage, "/Root/MorphAnimation")
            animations.append((morph_animation, []))
        for animation, _ in animations:
            if morph_names:
                animation.CreateBlendShapesAttr().Set(morph_names)
                animation.CreateBlendShapeWeightsAttr().Set(Vt.FloatArray(defaults))
        # 30 Hz baking preserves STEP/CUBICSPLINE and quaternion motion in USD
        # players with different interpolation rules; include every source key.
        for offset, duration, channels in self.clips:
            times = set(np.arange(0, duration, 1/FPS).tolist()) | {duration}
            for source_times, _, interpolation in channels.values():
                times.update(map(float, source_times))
                if interpolation == "STEP":
                    times.update(max(0, float(t)-1e-5) for t in source_times[1:])
            work = 3 * len(self.animated) + 4 * sum(len(ordered) for _, ordered in animations) + len(morph_names)
            if len(times) > MAX_SAMPLES or len(times) * work > 8_000_000:
                raise ValueError("Baked animation exceeds conversion budget")
            # A node whose scale track reaches 0 (a summoned object before it
            # appears) is hidden by time-sampled visibility, and its scale is
            # clamped to HIDDEN_SCALE: a zero scale is a singular transform,
            # and the tiny scale still hides it in players that ignore
            # animated visibility.
            hideable = {
                index for (index, path), (_, source_values, _) in channels.items()
                if path == "scale" and index in self.ops and np.abs(np.asarray(source_values, dtype=float)).reshape(-1, 3).max(axis=1).min() < 1e-9
            }
            for time in sorted(times):
                frame = (offset + time)*FPS
                values = {key: _sample(*channel, time, rotation=key[1] == "rotation") for key, channel in channels.items()}
                animated_worlds = {}
                def animated_world(index):
                    if index not in animated_worlds:
                        node = self.gltf.nodes[index]
                        if not any((index, path) in values for path in ("translation", "rotation", "scale")):
                            local = _local(node)
                        else:
                            t, r, s = _node_trs(node)
                            local = _trs(values.get((index, "translation"), t), values.get((index, "rotation"), r), values.get((index, "scale"), s))
                        animated_worlds[index] = local * (animated_world(self.parents[index]) if index in self.parents else Gf.Matrix4d(1))
                    return animated_worlds[index]
                for ancestor, op, _ in {str(space[1].GetAttr().GetPath()): space for space in self.skin_spaces.values()}.values():
                    if ancestor is not None:
                        op.Set(animated_world(ancestor), frame)
                for index, ops in self.ops.items():
                    if index not in self.animated:
                        continue
                    t, r, s = _node_trs(self.gltf.nodes[index])
                    ops[0].Set(Gf.Vec3d(*map(float, values.get((index, "translation"), t))), frame)
                    ops[1].Set(_quat(values.get((index, "rotation"), r)), frame)
                    scale = list(map(float, values.get((index, "scale"), s)))
                    if index in hideable:
                        hidden = max(abs(v) for v in scale) < 1e-9
                        UsdGeom.Imageable(ops[0].GetAttr().GetPrim()).CreateVisibilityAttr().Set("invisible" if hidden else "inherited", frame)
                        if hidden:
                            scale = [HIDDEN_SCALE] * 3
                    ops[2].Set(Gf.Vec3d(*scale), frame)
                weights = []
                for index, (names, default) in self.morphs.items():
                    value = values.get((index, "weights"), default)
                    if len(value) != len(names):
                        raise ValueError("Animation morph weights do not match mesh targets")
                    weights.extend(map(float, value))
                for animation, ordered in animations:
                    if ordered:
                        translations, rotations, scales = [], [], []
                        for index in ordered:
                            t, r, s = _node_trs(self.gltf.nodes[index])
                            translations.append(Gf.Vec3f(*map(float, values.get((index, "translation"), t))))
                            rotations.append(_quat(values.get((index, "rotation"), r)))
                            scales.append(Gf.Vec3h(*map(float, values.get((index, "scale"), s))))
                        animation.CreateTranslationsAttr().Set(Vt.Vec3fArray(translations), frame)
                        animation.CreateRotationsAttr().Set(Vt.QuatfArray(rotations), frame)
                        animation.CreateScalesAttr().Set(Vt.Vec3hArray(scales), frame)
                    if morph_names:
                        animation.GetBlendShapeWeightsAttr().Set(Vt.FloatArray(weights), frame)

    def audio(self, scene):
        extension = (self.gltf.extensions or {}).get("KHR_audio")
        if not extension:
            return
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            raise ValueError("Recorded audio conversion requires ffmpeg")
        emitters = (scene.extensions or {}).get("KHR_audio", {}).get("emitters", [])
        for emitter_index in emitters:
            emitter = extension["emitters"][emitter_index]
            if emitter.get("type") != "global":
                raise ValueError("Only capture's global KHR_audio emitter is supported")
            for source_index in emitter["sources"]:
                source = extension["sources"][source_index]
                audio = extension["audio"][source["audio"]]
                if "bufferView" not in audio:
                    raise ValueError("Audio must be embedded in GLB")
                data = _buffer_view(self.gltf, audio["bufferView"])
                formats = {"audio/webm": "matroska", "audio/ogg": "ogg", "audio/mp4": "mov", "audio/wav": "wav", "audio/mpeg": "mp3"}
                mime = audio.get("mimeType", "").split(";", 1)[0].lower()
                if mime not in formats:
                    raise ValueError("Unsupported recorded audio MIME type")
                input_path = Path(self.directory, f"audio_{source_index}.input")
                input_path.write_bytes(data)
                relative = f"audio_{source_index}.m4a"
                command = [ffmpeg, "-nostdin", "-v", "error", "-xerror", "-y", "-max_alloc", "268435456", "-protocol_whitelist", "file,pipe", "-threads", "2", "-f", formats[mime], "-i", str(input_path), "-t", str(MAX_DURATION), "-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000", "-threads", "2", "-movflags", "+faststart", str(Path(self.directory, relative))]
                process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
                try:
                    _, stderr = process.communicate(timeout=30)
                finally:
                    if process.poll() is None:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
                input_path.unlink()
                if process.returncode:
                    raise ValueError("Recorded audio could not be transcoded to AAC: " + stderr.decode(errors="replace")[:500])
                prim = UsdMedia.SpatialAudio.Define(self.stage, f"/Root/Audio_{emitter_index}_{source_index}")
                prim.CreateFilePathAttr().Set(Sdf.AssetPath(relative))
                prim.CreateAuralModeAttr().Set("nonSpatial")
                prim.CreatePlaybackModeAttr().Set("loopFromStage" if source.get("loop") else "onceFromStart")
                prim.CreateStartTimeAttr().Set(Sdf.TimeCode(0))
                prim.CreateMediaOffsetAttr().Set(0.0)
                prim.CreateGainAttr().Set(float(emitter.get("gain", 1)))

    def fit_points(self):
        """What the hologram draws, for fitting its cloche by the viewer's
        rules (drawnPoints and motionPoints in viewer-web): every visible
        mesh at the first frame, kept to the bubble when there is one, and
        the author's joints through the take with head room over the
        highest, plus the box corners of meshes the take moves by their own
        transform. The bubble is pinned here, so the walk is read in the
        stage's own space rather than relative to a following bubble."""
        root = UsdSkel.Root(self.stage.GetDefaultPrim())
        cache = UsdSkel.Cache()
        cache.Populate(root, Usd.PrimDefaultPredicate)
        inside = (lambda point: np.linalg.norm(point - self.bubble_center) <= self.bubble_radius) if self.bubble_center is not None else (lambda point: True)
        xforms = UsdGeom.XformCache(0)
        drawn, moving = [], []
        for prim in self.stage.Traverse():
            if not prim.IsA(UsdGeom.Mesh) or prim.GetCustomDataByKey("quickLookBackFaces") or prim.GetCustomDataByKey("quickLookPinnedBubble"):
                continue
            mesh = UsdGeom.Mesh(prim)
            points = mesh.GetPointsAttr().Get()
            if not points or mesh.ComputeVisibility() == "invisible":
                continue
            skinning = cache.GetSkinningQuery(prim)
            skeleton = UsdSkel.BindingAPI(prim).GetInheritedSkeleton()
            sampled = Vt.Vec3fArray(points)
            if skinning and skeleton:
                query = cache.GetSkelQuery(skeleton)
                if not skinning.ComputeSkinnedPoints(query.ComputeSkinningTransforms(0), sampled, 0):
                    raise ValueError("Unable to evaluate skinned points for the cloche")
                matrix = np.asarray(xforms.GetLocalToWorldTransform(skeleton.GetPrim()))
            else:
                matrix = np.asarray(xforms.GetLocalToWorldTransform(prim))
                ancestor = prim
                while ancestor:
                    if ancestor.IsA(UsdGeom.Xformable) and UsdGeom.Xformable(ancestor).TransformMightBeTimeVarying():
                        moving.append((prim, np.asarray(points)))
                        break
                    ancestor = ancestor.GetParent()
            step = max(1, len(sampled) // 3000)
            world = np.asarray(sampled)[::step] @ matrix[:3, :3] + matrix[3, :3]
            drawn.extend(point for point in world if inside(point))
        if self.duration > 0:
            skeletons = [UsdSkel.Skeleton(prim) for prim in self.stage.Traverse() if prim.IsA(UsdSkel.Skeleton)]
            first = {}
            for sample in range(8):
                frame = self.duration * sample / 8 * FPS
                xforms = UsdGeom.XformCache(frame)
                top = None
                for skeleton in skeletons:
                    query = cache.GetSkelQuery(skeleton)
                    for joint in query.ComputeJointWorldTransforms(xforms):
                        point = np.asarray(joint.ExtractTranslation())
                        drawn.append(point)
                        if top is None or point[1] > top[1]:
                            top = point
                if top is not None:
                    drawn.append(top + np.array([0, 0.18, 0]))
                for prim, points in moving:
                    matrix = np.asarray(xforms.GetLocalToWorldTransform(prim))
                    if prim not in first:
                        first[prim] = matrix
                        continue
                    if np.array_equal(first[prim], matrix):
                        continue
                    lower, upper = points.min(axis=0), points.max(axis=0)
                    for i in range(8):
                        corner = np.array([upper[0] if i & 1 else lower[0], upper[1] if i & 2 else lower[1], upper[2] if i & 4 else lower[2]])
                        point = corner @ matrix[:3, :3] + matrix[3, :3]
                        if inside(point):
                            drawn.append(point)
        return [[float(c) for c in point] for point in drawn]

    def cloche(self, seed):
        """The halo baked into the preview (styleguide 3.4, 9.5): the dome
        fitted by fitCloche's rules, then the form `cloche.build` makes of it
        (the burnt globe: burning fronts and embers), carried by geometry
        because RealityKit has no shader. It replaces the bubble's old blue
        shell, as on the web. Never in the GLB: it exists only in this preview."""
        points = self.fit_points()
        shape = cloche_rules.fit_cloche(points)
        if shape is None:
            return
        built = cloche_rules.build(shape, seed)
        group = UsdGeom.Xform.Define(self.stage, "/Root/Cloche")
        group.AddTranslateOp().Set(Gf.Vec3d(*shape["base"]))
        group.GetPrim().SetCustomDataByKey("quickLookCloche", {
            "seed": seed,
            "base": Gf.Vec3d(*shape["base"]),
            "radii": Gf.Vec3d(*shape["radii"]),
            "exponent": shape["exponent"],
            "fitPoints": len(points),
            **built["summary"],
        })
        for part in built["parts"]:
            name, geometry = part["name"], part["mesh"]
            material = UsdShade.Material.Define(self.stage, f"/Root/Materials/Cloche{name}")
            surface = UsdShade.Shader.Define(self.stage, f"/Root/Materials/Cloche{name}/Surface")
            surface.CreateIdAttr("UsdPreviewSurface")
            # Diffuse and emissive only: no reflection, so the fronts never flash over the people inside.
            for key, kind, value in [("diffuseColor", Sdf.ValueTypeNames.Color3f, Gf.Vec3f(*part["diffuse"])), ("emissiveColor", Sdf.ValueTypeNames.Color3f, Gf.Vec3f(*part["emissive"])), ("metallic", Sdf.ValueTypeNames.Float, 0.0), ("roughness", Sdf.ValueTypeNames.Float, 0.85), ("useSpecularWorkflow", Sdf.ValueTypeNames.Int, 1), ("specularColor", Sdf.ValueTypeNames.Color3f, Gf.Vec3f(0)), ("opacity", Sdf.ValueTypeNames.Float, part["opacity"])]:
                surface.CreateInput(key, kind).Set(value)
            surface.CreateOutput("surface", Sdf.ValueTypeNames.Token)
            material.CreateSurfaceOutput().ConnectToSource(surface.ConnectableAPI(), "surface")
            mesh = UsdGeom.Mesh.Define(self.stage, f"/Root/Cloche/{name}")
            mesh.GetPrim().SetCustomDataByKey("quickLookCloche", True)
            mesh.CreatePointsAttr().Set(Vt.Vec3fArray.FromNumpy(np.asarray(geometry["points"], dtype=np.float32)))
            mesh.CreateNormalsAttr().Set(Vt.Vec3fArray.FromNumpy(np.asarray(geometry["normals"], dtype=np.float32)))
            mesh.SetNormalsInterpolation("vertex")
            mesh.CreateFaceVertexIndicesAttr().Set(Vt.IntArray(geometry["indices"]))
            mesh.CreateFaceVertexCountsAttr().Set(Vt.IntArray([3] * (len(geometry["indices"]) // 3)))
            mesh.CreateSubdivisionSchemeAttr().Set("none")
            # Closed tubes and solids: RealityKit ignores doubleSided.
            mesh.CreateDoubleSidedAttr().Set(False)
            mesh.CreateExtentAttr().Set(mesh.ComputeExtent(mesh.GetPointsAttr().Get()))
            UsdShade.MaterialBindingAPI.Apply(mesh.GetPrim()).Bind(material)
        for prim in self.stage.Traverse():
            # Its back faces reference it, so they carry the flag too.
            if prim.GetCustomDataByKey("quickLookPinnedBubble"):
                UsdGeom.Imageable(prim).CreateVisibilityAttr().Set("invisible")

    def extents(self):
        # The default UsdSkel padding heuristic compares bind-space vertices
        # with rest-pose joint positions. Recordings can start far from the
        # origin, making that heuristic tens of meters too large. Author a
        # tight, constant animation-wide extent from evaluated skin+morph data.
        # Keep points in bind space; only the bound is baked, never deformation.
        root = UsdSkel.Root(self.stage.GetDefaultPrim())
        cache = UsdSkel.Cache()
        cache.Populate(root, Usd.PrimDefaultPredicate)
        meshes = []
        frames = {0.0, self.duration * FPS}
        for prim in self.stage.Traverse():
            for attribute in prim.GetAttributes():
                frames.update(attribute.GetTimeSamples())
            if not prim.IsA(UsdGeom.Mesh) or prim.GetCustomDataByKey("quickLookBackFaces"):
                continue
            mesh = UsdGeom.Mesh(prim)
            points = mesh.GetPointsAttr().Get()
            if not points or mesh.ComputeVisibility() == "invisible":
                continue
            binding = UsdSkel.BindingAPI(prim)
            skeleton = binding.GetInheritedSkeleton()
            query = cache.GetSkelQuery(skeleton) if skeleton else None
            skinning = cache.GetSkinningQuery(prim) if skeleton else None
            names = list(binding.GetBlendShapesAttr().Get() or [])
            blend = UsdSkel.BlendShapeQuery(binding) if names else None
            animation = query.GetAnimQuery() if query else cache.GetAnimQuery(binding.GetInheritedAnimationSource())
            # Rigid meshes under a constant transform chain (scene props) have
            # one pose; evaluate them once instead of at every frame.
            ancestor, moving = prim, bool(skinning or blend)
            while not moving and ancestor:
                moving = ancestor.IsA(UsdGeom.Xformable) and UsdGeom.Xformable(ancestor).TransformMightBeTimeVarying()
                ancestor = ancestor.GetParent()
            meshes.append((prim, points, skeleton, query, skinning, names, blend, animation, moving))
        if sum(len(entry[1]) * (len(frames) if entry[8] else 1) for entry in meshes) > 100_000_000:
            raise ValueError("Animation extent evaluation exceeds conversion budget")
        lower, upper = np.full(3, np.inf), np.full(3, -np.inf)
        for index, frame in enumerate(sorted(frames)):
            xforms = UsdGeom.XformCache(frame)
            for prim, original, skeleton, query, skinning, names, blend, animation, moving in meshes:
                if index and not moving:
                    continue
                points = Vt.Vec3fArray(original)
                if blend:
                    order = list(animation.GetBlendShapeOrder())
                    animated_weights = list(animation.ComputeBlendShapeWeights(frame))
                    weights = Vt.FloatArray([animated_weights[order.index(name)] for name in names])
                    weights, blend_indices, subshape_indices = blend.ComputeSubShapeWeights(weights)
                    if not blend.ComputeDeformedPoints(weights, blend_indices, subshape_indices, blend.ComputeBlendShapePointIndices(), blend.ComputeSubShapePointOffsets(), points):
                        raise ValueError("Unable to evaluate morph extent")
                if skinning:
                    if not skinning.ComputeSkinnedPoints(query.ComputeSkinningTransforms(frame), points, frame):
                        raise ValueError("Unable to evaluate skinned extent")
                    matrix = np.asarray(xforms.GetLocalToWorldTransform(skeleton.GetPrim()))
                else:
                    matrix = np.asarray(xforms.GetLocalToWorldTransform(prim))
                world = np.asarray(points) @ matrix[:3, :3] + matrix[3, :3]
                lower = np.minimum(lower, world.min(axis=0))
                upper = np.maximum(upper, world.max(axis=0))
        if np.all(np.isfinite(lower)) and np.all(np.isfinite(upper)):
            extent = np.asarray([lower - 0.02, upper + 0.02], dtype=np.float32)
            root.CreateExtentAttr().Set(Vt.Vec3fArray.FromNumpy(extent))
            root.GetPrim().SetCustomDataByKey("quickLookExtentSamples", len(frames))


CREDIT_FIELDS = ("source", "sourceUrl", "title", "author", "licence")


def _write_credits(stage, document):
    # PRD-060: credit for borrowed objects survives into the USDZ's root layer.
    # "holoim:copyright" is asset.copyright; "holoim:credits" is a JSON string
    # (a list of credit objects, one per credited node), since USD dictionaries
    # cannot hold lists of dictionaries. Invalid credits are skipped.
    data = {}
    copyright_text = document.get("asset", {}).get("copyright")
    if isinstance(copyright_text, str) and copyright_text:
        data["holoim:copyright"] = copyright_text[:2000]
    credits = []
    for node in document.get("nodes", []):
        extras = node.get("extras")
        credit = extras.get("holoimCredit") if isinstance(extras, dict) else None
        if isinstance(credit, dict) and all(isinstance(credit.get(f), str) and credit.get(f) for f in CREDIT_FIELDS):
            credits.append({f: credit[f][:500] for f in CREDIT_FIELDS})
        if len(credits) >= 100:
            break
    if credits:
        data["holoim:credits"] = json.dumps(credits, ensure_ascii=False, separators=(",", ":"))
    if data:
        stage.GetRootLayer().customLayerData = data


def _convert_glb_to_usdz(input_path, output_path, seed):
    # pygltflib's Node dataclass omits the standard node.weights override.
    with open(input_path, "rb") as source:
        header = source.read(20)
        if len(header) != 20 or header[:4] != b"glTF" or struct.unpack("<I", header[4:8])[0] != 2 or header[16:20] != b"JSON":
            raise ValueError("Expected a GLB 2.0 file")
        length = struct.unpack("<I", header[8:12])[0]
        json_length = struct.unpack("<I", header[12:16])[0]
        if length != os.fstat(source.fileno()).st_size or length > MAX_INPUT_BYTES or json_length > min(length - 20, 16 * 1024 * 1024):
            raise ValueError("Invalid or excessively large GLB")
        def invalid_constant(value):
            raise ValueError("Non-finite JSON number: " + value)
        document = json.loads(source.read(json_length), parse_constant=invalid_constant)
    if len(document.get("nodes", [])) > 10000 or len(document.get("accessors", [])) > 20000:
        raise ValueError("GLB exceeds object count limit")
    gltf = pygltflib.GLTF2.load(input_path)
    if len(gltf.buffers) != 1 or gltf.buffers[0].uri:
        raise ValueError("Quick Look conversion requires a single embedded GLB buffer")
    for index, node in enumerate(document.get("nodes", [])):
        if "weights" in node:
            gltf.nodes[index].weights = node["weights"]
    unsupported = set(gltf.extensionsRequired or []) - SUPPORTED_EXTENSIONS
    if unsupported:
        raise ValueError("Unsupported required glTF extensions: " + ", ".join(sorted(unsupported)))
    optional = set(gltf.extensionsUsed or []) - SUPPORTED_EXTENSIONS
    if optional:
        print("Quick Look uses core-material fallback for optional extensions: " + ", ".join(sorted(optional)), file=sys.stderr)
    scene_index = gltf.scene if gltf.scene is not None else 0
    if not gltf.scenes or scene_index < 0 or scene_index >= len(gltf.scenes):
        raise ValueError("No scene found in GLB")
    destination = Path(output_path).resolve()
    with tempfile.TemporaryDirectory(prefix=".quicklook-", dir=destination.parent) as directory:
        layer_path = str(Path(directory, "model.usdc"))
        stage = Usd.Stage.CreateInMemory()
        # Apple registers these as stage metadata. Stock OpenUSD does not know
        # their schema; USDA import preserves the actual fields in the USDC.
        # customLayerData with the same keys is NOT Apple playback metadata.
        stage.GetRootLayer().ImportFromString('#usda 1.0\n(autoPlay = true\nplaybackMode = "loop")\n')
        UsdGeom.SetStageMetersPerUnit(stage, 1.0)
        UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.y)
        root = UsdSkel.Root.Define(stage, "/Root")
        stage.SetDefaultPrim(root.GetPrim())
        Usd.ModelAPI(root.GetPrim()).SetKind(Kind.Tokens.component)
        converter = Converter(gltf, stage, directory)
        converter.skeletons()
        scene = gltf.scenes[scene_index]
        for index in scene.nodes:
            converter.node(index, "/Root")
        converter.finish_geometry()
        converter.animate()
        converter.cloche(seed)
        converter.extents()
        converter.audio(scene)
        _write_credits(stage, document)
        stage.GetRootLayer().Export(layer_path)
        package = Path(directory, "package.usdz")
        # Every dependency was created here under a controlled relative name.
        # Use USD's native aligned ZIP writer instead of asset localization,
        # which can rewrite live-layer paths while packaging anonymous layers.
        # The root USDC must be the first (uncompressed, 64-byte aligned) entry.
        resources = sorted(resource for resource in Path(directory).rglob("*") if resource.is_file() and resource != Path(layer_path))
        with Sdf.ZipFileWriter.CreateNew(str(package)) as archive:
            if not archive.AddFile(layer_path, "model.usdc"):
                raise ValueError("USDZ root packaging failed")
            for resource in resources:
                if not archive.AddFile(str(resource), resource.relative_to(directory).as_posix()):
                    raise ValueError("USDZ resource packaging failed")
        if package.stat().st_size > MAX_INPUT_BYTES * 4:
            raise ValueError("Converted package exceeds size limit")
        os.replace(package, destination)
    print(f"Successfully converted {input_path} -> {output_path}")


def convert_glb_to_usdz(input_path, output_path, seed=None):
    # Finish cleanup before the API's 120-second process deadline. The ffmpeg
    # finally block also kills its process group if this alarm interrupts it.
    def deadline(_number, _frame):
        raise TimeoutError("Quick Look conversion exceeded 100 seconds")
    previous = signal.signal(signal.SIGALRM, deadline)
    signal.alarm(100)
    try:
        # The hologram's id seeds its cloche's burns (Q10); a file converted on
        # its own is seeded by its name, as the stored GLB's name.
        _convert_glb_to_usdz(input_path, output_path, seed if seed is not None else Path(input_path).stem)
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)


if __name__ == "__main__":
    if len(sys.argv) not in (3, 5) or len(sys.argv) == 5 and sys.argv[3] != "--seed":
        sys.exit(f"Usage: {sys.argv[0]} <input.glb> <output.usdz> [--seed <hologram id>]")
    try:
        convert_glb_to_usdz(sys.argv[1], sys.argv[2], sys.argv[4] if len(sys.argv) == 5 else None)
    except Exception as error:
        print(f"Quick Look conversion failed: {error}", file=sys.stderr)
        sys.exit(1)
