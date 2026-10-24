#!/usr/bin/env python3
"""Independent GLB -> USDZ readback oracle, including evaluated UsdSkel vertices.

Usage: inspect_usdz.py source.glb result.usdz report.json
Requires the converter's pinned requirements.txt and ffprobe for audio recordings.
No converter code is imported. Source matrices use column vectors; USD evaluation
uses UsdSkel.Cache and BlendShapeQuery, rather than counting authored attributes.
This validates package data, not Apple rendering or physical phone playback.
"""

import base64
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile

import numpy as np
from PIL import Image
from pxr import Usd, UsdGeom, UsdMedia, UsdShade, UsdSkel, Vt


class Source:
    def __init__(self, path):
        raw = Path(path).read_bytes()
        magic, version, size = struct.unpack_from("<4sII", raw)
        if magic != b"glTF" or version != 2 or size != len(raw):
            raise ValueError("Invalid GLB header")
        offset, self.binary = 12, b""
        while offset < size:
            length, kind = struct.unpack_from("<I4s", raw, offset)
            data = raw[offset + 8:offset + 8 + length]
            if len(data) != length:
                raise ValueError("Truncated GLB chunk")
            if kind == b"JSON":
                self.doc = json.loads(data)
            elif kind == b"BIN\0":
                self.binary = data
            offset += 8 + length
        self.parents = {child: i for i, n in enumerate(self.doc.get("nodes", [])) for child in n.get("children", [])}
        self.arrays = {}
        self.channels = {}
        self.keys = {0.0}
        for animation in self.doc.get("animations", [])[:1]:
            for channel in animation["channels"]:
                sampler = animation["samplers"][channel["sampler"]]
                times = self.accessor(sampler["input"]).reshape(-1)
                interp = sampler.get("interpolation", "LINEAR")
                values = self.accessor(sampler["output"]).reshape(len(times), 3 if interp == "CUBICSPLINE" else 1, -1)
                self.channels[channel["target"]["node"], channel["target"]["path"]] = (times, values, interp)
                self.keys.update(float(t) for t in times)
        self.bubble = next((i for i, n in enumerate(self.doc.get("nodes", [])) if n.get("name") == "RecordedBubbleSphere"), None)

    def view(self, index):
        view = self.doc["bufferViews"][index]
        if view.get("buffer", 0) != 0 or self.doc["buffers"][0].get("uri"):
            raise ValueError("Inspector expects embedded GLB buffers")
        start = view.get("byteOffset", 0)
        return self.binary[start:start + view["byteLength"]]

    def accessor(self, index):
        if index in self.arrays:
            return self.arrays[index]
        a = self.doc["accessors"][index]
        width = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[a["type"]]
        dtype = np.dtype({5120: "i1", 5121: "u1", 5122: "<i2", 5123: "<u2", 5125: "<u4", 5126: "<f4"}[a["componentType"]])
        out = np.zeros((a["count"], width), dtype=dtype)
        if "bufferView" in a:
            view = self.doc["bufferViews"][a["bufferView"]]
            blob = self.view(a["bufferView"])
            stride = view.get("byteStride", width * dtype.itemsize)
            # Decode rows independently instead of sharing converter accessor code.
            for row in range(a["count"]):
                out[row] = np.frombuffer(blob, dtype=dtype, count=width, offset=a.get("byteOffset", 0) + row * stride)
        sparse = a.get("sparse")
        if sparse:
            indices, values = sparse["indices"], sparse["values"]
            idtype = {5121: "u1", 5123: "<u2", 5125: "<u4"}[indices["componentType"]]
            ids = np.frombuffer(self.view(indices["bufferView"]), dtype=idtype, count=sparse["count"], offset=indices.get("byteOffset", 0))
            replacement = np.frombuffer(self.view(values["bufferView"]), dtype=dtype, count=sparse["count"] * width, offset=values.get("byteOffset", 0)).reshape(-1, width)
            out[ids] = replacement
        if a.get("normalized") and a["componentType"] != 5126:
            out = np.clip(out.astype(float) / np.iinfo(dtype).max, -1, 1)
        self.arrays[index] = out
        return out

    def value(self, node, component, time, default):
        channel = self.channels.get((node, component))
        if channel is None:
            return np.asarray(default, dtype=float)
        times, values, interp = channel
        if node == self.bubble:
            time = float(times[0])
        if time <= times[0]:
            result = values[0, 1 if interp == "CUBICSPLINE" else 0]
        elif time >= times[-1]:
            result = values[-1, 1 if interp == "CUBICSPLINE" else 0]
        else:
            left = int(np.searchsorted(times, time, side="right")) - 1
            span = float(times[left + 1] - times[left])
            fraction = (time - times[left]) / span
            if interp == "STEP":
                result = values[left, 0]
            elif interp == "CUBICSPLINE":
                # Hermite basis evaluated as a matrix product.
                basis = np.array([2*fraction**3 - 3*fraction**2 + 1, fraction**3 - 2*fraction**2 + fraction, -2*fraction**3 + 3*fraction**2, fraction**3 - fraction**2])
                result = basis @ np.array([values[left, 1], span*values[left, 2], values[left+1, 1], span*values[left+1, 0]])
            else:
                a, b = values[left, 0], values[left+1, 0]
                if component == "rotation":
                    dot = float(a @ b)
                    if dot < 0:
                        b, dot = -b, -dot
                    angle = np.arccos(np.clip(dot, -1, 1))
                    result = (np.sin((1-fraction)*angle)*a + np.sin(fraction*angle)*b)/np.sin(angle) if angle > 1e-4 else a*(1-fraction)+b*fraction
                else:
                    result = a*(1-fraction)+b*fraction
        return result / np.linalg.norm(result) if component == "rotation" else result

    def worlds(self, time):
        result = {}
        def world(index):
            if index in result:
                return result[index]
            node = self.doc["nodes"][index]
            if "matrix" in node:
                local = np.array(node["matrix"]).reshape(4, 4, order="F")
            else:
                x, y, z, w = self.value(index, "rotation", time, node.get("rotation", [0, 0, 0, 1]))
                local = np.eye(4)
                local[:3, :3] = [[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)], [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)], [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]]
                local[:3, :3] *= self.value(index, "scale", time, node.get("scale", [1, 1, 1]))[None, :]
                local[:3, 3] = self.value(index, "translation", time, node.get("translation", [0, 0, 0]))
            result[index] = world(self.parents[index]) @ local if index in self.parents else local
            return result[index]
        for index in range(len(self.doc.get("nodes", []))):
            world(index)
        return result

    def weights(self, index, count, time):
        node = self.doc["nodes"][index]
        mesh = self.doc["meshes"][node["mesh"]]
        return self.value(index, "weights", time, node.get("weights", mesh.get("weights", [0]*count)))

    def points(self, index, primitive, time, worlds):
        attrs = primitive["attributes"]
        points = self.accessor(attrs["POSITION"]).astype(float).copy()
        targets = primitive.get("targets", [])
        for weight, target in zip(self.weights(index, len(targets), time), targets):
            if "POSITION" in target:
                points += weight * self.accessor(target["POSITION"])
        points = np.column_stack((points, np.ones(len(points))))
        node = self.doc["nodes"][index]
        if "skin" not in node:
            return (worlds[index] @ points.T).T[:, :3]
        skin = self.doc["skins"][node["skin"]]
        inverse = self.accessor(skin["inverseBindMatrices"]).reshape(-1, 4, 4).transpose(0, 2, 1) if "inverseBindMatrices" in skin else np.repeat(np.eye(4)[None], len(skin["joints"]), axis=0)
        matrices = np.array([worlds[joint] @ inv for joint, inv in zip(skin["joints"], inverse)])
        joint_arrays, weight_arrays = [], []
        for number in range(2):
            if f"JOINTS_{number}" in attrs:
                joint_arrays.append(self.accessor(attrs[f"JOINTS_{number}"]).astype(int))
                weight_arrays.append(self.accessor(attrs[f"WEIGHTS_{number}"]))
        joints, weights = np.concatenate(joint_arrays, axis=1), np.concatenate(weight_arrays, axis=1).astype(float)
        weights /= weights.sum(axis=1)[:, None]
        transformed = np.einsum("nvij,nj->nvi", matrices[joints], points)
        return np.einsum("nv,nvi->ni", weights, transformed)[:, :3]

    def image(self, index):
        image = self.doc["images"][index]
        return self.view(image["bufferView"]) if "bufferView" in image else base64.b64decode(image["uri"].split(",", 1)[1])


class Inspection:
    def __init__(self, source_path, usdz_path):
        self.source = Source(source_path)
        self.stage = Usd.Stage.Open(str(Path(usdz_path).resolve()))
        self.archive = zipfile.ZipFile(usdz_path)
        self.report = {"passed": False, "scope": "Independent source math and OpenUSD evaluated readback; Apple renderer and physical iPhone playback are not tested", "source": str(source_path), "usdz": str(usdz_path), "failures": [], "geometry": [], "materials": [], "audio": [], "package": {"entries": self.archive.namelist()}}
        self.report["numericalMaxima"] = {}
        self.evaluated_min = np.full(3, np.inf)
        self.evaluated_max = np.full(3, -np.inf)
        self.cache = UsdSkel.Cache()
        for prim in self.stage.Traverse():
            if prim.IsA(UsdSkel.Root):
                self.cache.Populate(UsdSkel.Root(prim), Usd.PrimDefaultPredicate)

    def check(self, condition, message):
        if not condition and message not in self.report["failures"]:
            self.report["failures"].append(message)

    def close(self, actual, expected, tolerance, label):
        a, b = np.asarray(actual, dtype=float), np.asarray(expected, dtype=float)
        if a.shape != b.shape:
            self.check(False, f"{label}: shape {a.shape} != {b.shape}")
            return 1e300
        error = float(np.max(np.abs(a-b))) if a.size else 0
        self.report["numericalMaxima"][label] = max(self.report["numericalMaxima"].get(label, 0), error if np.isfinite(error) else 1e300)
        self.check(np.isfinite(error) and error <= tolerance, f"{label}: exceeds tolerance {tolerance}; see numericalMaxima")
        return error

    def asset(self, value):
        name = value.path if hasattr(value, "path") else str(value)
        self.check(name in self.archive.namelist(), f"Asset is not packaged locally: {name}")
        return self.archive.read(name)

    def bounds(self, points):
        if len(points):
            self.evaluated_min = np.minimum(self.evaluated_min, np.min(points, axis=0))
            self.evaluated_max = np.maximum(self.evaluated_max, np.max(points, axis=0))

    def geometry(self):
        source = self.source
        all_keys = sorted(source.keys)
        # Bound pathological recordings while retaining first/last, per-channel
        # extrema, representative exact keys, and interval midpoints.
        exact = all_keys if len(all_keys) <= 65 else [all_keys[i] for i in np.linspace(0, len(all_keys)-1, 65).astype(int)]
        for times, values, interpolation in source.channels.values():
            key_values = values[:, 1 if interpolation == "CUBICSPLINE" else 0]
            for key_index in [np.argmax(np.linalg.norm(key_values, axis=1)), np.argmin(np.linalg.norm(key_values, axis=1))]:
                exact.append(float(times[key_index]))
        exact = sorted(set(exact))
        times = sorted(set(exact + [(a+b)/2 for a, b in zip(exact, exact[1:])]))
        self.report["sampling"] = {"sourceKeyCount": len(all_keys), "exactKeys": exact, "timesSeconds": times, "policy": "All vertices; all source keys up to 65, otherwise uniform exact keys plus every channel magnitude extrema; adjacent selected-key midpoints"}
        fps = self.stage.GetTimeCodesPerSecond()
        self.check(fps > 0, "Invalid USD time codes per second")
        self.close(self.stage.GetEndTimeCode()/fps, max(all_keys) if max(all_keys) else 1/fps, 1e-5, "animation duration")
        nodes, meshes, skeletons = {}, [], []
        for prim in self.stage.Traverse():
            if prim.IsA(UsdGeom.Xform) and prim.GetCustomDataByKey("gltfNodeIndex") is not None:
                nodes[prim.GetCustomDataByKey("gltfNodeIndex")] = prim
            if prim.IsA(UsdGeom.Mesh) and not prim.GetCustomDataByKey("quickLookBackFaces"):
                meshes.append(prim)
            if prim.IsA(UsdSkel.Skeleton):
                skeletons.append(prim)
        active = set()
        def visit(index):
            active.add(index)
            for child in source.doc["nodes"][index].get("children", []):
                visit(child)
        for index in source.doc["scenes"][source.doc.get("scene", 0)].get("nodes", []):
            visit(index)
        self.check(active <= set(nodes), "Source scene node transforms are missing")
        expected_meshes = {(i, p) for i in active if "mesh" in source.doc["nodes"][i] for p in range(len(source.doc["meshes"][source.doc["nodes"][i]["mesh"]]["primitives"]))}
        actual_meshes = {(p.GetCustomDataByKey("gltfNodeIndex"), p.GetCustomDataByKey("gltfPrimitiveIndex")) for p in meshes}
        self.check(expected_meshes == actual_meshes, "Source primitive set differs from USD meshes")
        max_world_error, max_joint_error = 0, 0
        for time in times:
            worlds = source.worlds(time)
            xforms = UsdGeom.XformCache(time*fps)
            for index, prim in nodes.items():
                max_world_error = max(max_world_error, self.close(np.array(xforms.GetLocalToWorldTransform(prim)).T, worlds[index], 3e-3, f"node {index} world transform"))
            for prim in skeletons:
                query = self.cache.GetSkelQuery(UsdSkel.Skeleton(prim))
                indices = prim.GetCustomDataByKey("gltfJointNodeIndices")
                evaluated = query.ComputeJointWorldTransforms(xforms)
                self.check(indices is not None and len(indices) == len(evaluated), f"Skeleton {prim.GetPath()} lacks joint provenance")
                if indices is not None:
                    for index, matrix in zip(indices, evaluated):
                        max_joint_error = max(max_joint_error, self.close(np.array(matrix).T, worlds[index], 3e-3, f"joint {index} world transform"))
        self.report["transforms"] = {"maximumNodeWorldError": max_world_error, "maximumJointWorldError": max_joint_error, "nodeCount": len(nodes), "skeletonCount": len(skeletons)}
        bubble_world = source.worlds(0)
        center = radius = None
        if source.bubble is not None:
            node = source.doc["nodes"][source.bubble]
            primitive = source.doc["meshes"][node["mesh"]]["primitives"][0]
            center = bubble_world[source.bubble][:3, 3]
            radius = float(np.linalg.norm(source.accessor(primitive["attributes"]["POSITION"]), axis=1).max() * np.linalg.norm(bubble_world[source.bubble][:3, :3], axis=0).max())
            self.report["bubble"] = {"center": center.tolist(), "radius": radius, "policy": "Pinned first recorded bubble pose; static surrounding geometry must remain inside sphere"}
        for prim in meshes:
            index, pindex = prim.GetCustomDataByKey("gltfNodeIndex"), prim.GetCustomDataByKey("gltfPrimitiveIndex")
            node = source.doc["nodes"][index]
            primitive = source.doc["meshes"][node["mesh"]]["primitives"][pindex]
            mesh, binding = UsdGeom.Mesh(prim), UsdSkel.BindingAPI(prim)
            original = mesh.GetPointsAttr().Get()
            faces = np.array(mesh.GetFaceVertexIndicesAttr().Get())
            counts = np.array(mesh.GetFaceVertexCountsAttr().Get())
            self.check(np.all(counts == 3) and int(counts.sum()) == len(faces), f"mesh {index}/{pindex} invalid triangle topology")
            self.check(not len(faces) or (int(faces.min()) >= 0 and int(faces.max()) < len(original)), f"mesh {index}/{pindex} out-of-range triangle index")
            self.check(np.all(np.isfinite(np.array(original))), f"mesh {index}/{pindex} non-finite points")
            if "material" in primitive:
                bound, _ = UsdShade.MaterialBindingAPI(prim).ComputeBoundMaterial()
                if index == source.bubble:
                    self.check(bool(bound) and str(bound.GetPath()) == "/Root/Materials/QuickLookBubble", "Bubble is missing its deliberate translucent USD approximation")
                    if bound:
                        shell = UsdShade.Shader(self.stage.GetPrimAtPath(str(bound.GetPath()) + "/Surface"))
                        opacity, metallic, roughness = [float(shell.GetInput(name).Get()) for name in ("opacity", "metallic", "roughness")]
                        # Validate the approximation's presentation contract;
                        # exact low-specular appearance remains a visual choice.
                        self.check(0 < opacity <= .08 and 0 <= metallic <= .1 and .25 <= roughness <= 1, "Bubble shell must remain faint, translucent and low-specular")
                        self.report["bubbleApproximationMaterial"] = {"opacity": opacity, "metallic": metallic, "roughness": roughness}
                else:
                    self.check(bool(bound) and bound.GetPrim().GetCustomDataByKey("gltfMaterialIndex") == primitive["material"], f"mesh {index}/{pindex} lost authored material binding")
            ancestors, ancestor = [], index
            while ancestor is not None:
                ancestors.append(ancestor)
                ancestor = source.parents.get(ancestor)
            environment = any(source.doc["nodes"][i].get("name") == "RecordedSceneBubble" for i in ancestors)
            clipped = bool(prim.GetCustomDataByKey("quickLookClippedEnvironment"))
            self.check(not environment or center is None or clipped, f"Environment {index}/{pindex} was not bounded")
            entry = {"node": index, "primitive": pindex, "path": str(prim.GetPath()), "vertices": len(original), "clippedEnvironment": clipped}
            if clipped:
                for semantic in primitive["attributes"]:
                    if semantic.startswith("TEXCOORD_"):
                        number = int(semantic.split("_")[1])
                        uv = UsdGeom.PrimvarsAPI(prim).GetPrimvar("st" if number == 0 else f"st{number}").Get()
                        self.check(uv is not None and (not len(original) or len(uv) == len(original)) and np.all(np.isfinite(np.array(uv))), f"clipped environment {index}/{pindex} lost valid {semantic}")
                if "NORMAL" in primitive["attributes"]:
                    normals = mesh.GetNormalsAttr().Get()
                    self.check(normals is not None and (not len(original) or len(normals) == len(original)) and np.all(np.isfinite(np.array(normals))), f"clipped environment {index}/{pindex} lost normals")
                if len(original):
                    matrix = np.array(UsdGeom.XformCache(0).GetLocalToWorldTransform(prim)).T
                    world_points = (matrix @ np.column_stack((np.array(original), np.ones(len(original)))).T).T[:, :3]
                    distance = float(np.linalg.norm(world_points-center, axis=1).max())
                    self.check(distance <= radius + 1e-4, f"Environment {index}/{pindex} protrudes beyond bubble: {distance} > {radius}")
                    entry["maximumSphereDistance"] = distance
                    for time in times:
                        matrix = np.array(UsdGeom.XformCache(time*fps).GetLocalToWorldTransform(prim)).T
                        self.bounds((matrix @ np.column_stack((np.array(original), np.ones(len(original)))).T).T[:, :3])
                self.report["geometry"].append(entry)
                continue
            self.close(original, source.accessor(primitive["attributes"]["POSITION"]), 1e-6, f"mesh {index}/{pindex} bind vertices")
            expected_faces = source.accessor(primitive["indices"]).reshape(-1) if "indices" in primitive else np.arange(len(original))
            self.close(faces, expected_faces, 0, f"mesh {index}/{pindex} triangle indices")
            for semantic, accessor in primitive["attributes"].items():
                if semantic.startswith("TEXCOORD_"):
                    number = int(semantic.split("_")[1])
                    uv = UsdGeom.PrimvarsAPI(prim).GetPrimvar("st" if number == 0 else f"st{number}").Get()
                    expected = source.accessor(accessor).copy()
                    expected[:, 1] = 1-expected[:, 1]
                    self.close(uv, expected, 1e-6, f"mesh {index}/{pindex} {semantic}")
                elif semantic == "NORMAL":
                    self.close(mesh.GetNormalsAttr().Get(), source.accessor(accessor), 1e-6, f"mesh {index}/{pindex} normals")
            query = self.cache.GetSkinningQuery(prim)
            skeleton = binding.GetInheritedSkeleton()
            skel_query = self.cache.GetSkelQuery(skeleton) if skeleton else None
            anim_query = skel_query.GetAnimQuery() if skel_query else self.cache.GetAnimQuery(binding.GetInheritedAnimationSource())
            blend = UsdSkel.BlendShapeQuery(binding) if primitive.get("targets") else None
            max_vertex, max_weight, movement = 0, 0, 0
            first = None
            for time in times:
                frame = time*fps
                points = Vt.Vec3fArray(original)
                if blend:
                    self.check(bool(anim_query), f"mesh {index} has no effective morph animation")
                    names = list(anim_query.GetBlendShapeOrder())
                    animated_weights = list(anim_query.ComputeBlendShapeWeights(frame))
                    local_names = list(binding.GetBlendShapesAttr().Get())
                    weights = [animated_weights[names.index(name)] for name in local_names]
                    max_weight = max(max_weight, self.close(weights, source.weights(index, len(local_names), time), 2e-3, f"mesh {index} facial weights"))
                    weights, blend_indices, subshape_indices = blend.ComputeSubShapeWeights(Vt.FloatArray(weights))
                    self.check(blend.ComputeDeformedPoints(weights, blend_indices, subshape_indices, blend.ComputeBlendShapePointIndices(), blend.ComputeSubShapePointOffsets(), points), f"mesh {index} USD blend evaluation failed")
                if "skin" in node:
                    self.check(bool(query) and bool(skel_query), f"mesh {index} lacks valid USD skin binding")
                    self.check(query.ComputeSkinnedPoints(skel_query.ComputeSkinningTransforms(frame), points, frame), f"mesh {index} USD skinning failed")
                    matrix = np.array(UsdGeom.XformCache(frame).GetLocalToWorldTransform(skeleton.GetPrim())).T
                else:
                    matrix = np.array(UsdGeom.XformCache(frame).GetLocalToWorldTransform(prim)).T
                actual = (matrix @ np.column_stack((np.array(points), np.ones(len(points)))).T).T[:, :3]
                self.bounds(actual)
                expected = source.points(index, primitive, time, source.worlds(time))
                max_vertex = max(max_vertex, self.close(actual, expected, 3e-3, f"mesh {index}/{pindex} evaluated vertices"))
                if first is None:
                    first = actual
                movement = max(movement, float(np.max(np.linalg.norm(actual-first, axis=1))) if len(actual) else 0)
            entry.update({"maximumEvaluatedVertexErrorMeters": max_vertex, "maximumMorphWeightError": max_weight, "maximumVertexMotionMeters": movement, "morphTargetCount": len(primitive.get("targets", [])), "skinned": "skin" in node})
            self.report["geometry"].append(entry)
        extent = UsdGeom.Boundable(self.stage.GetDefaultPrim()).GetExtentAttr().Get()
        self.check(extent is not None and np.array(extent).shape == (2, 3), "Root lacks an explicit animation-wide framing extent")
        if extent is not None and np.array(extent).shape == (2, 3):
            extent = np.array(extent)
            self.check(np.all(extent[0] <= self.evaluated_min+1e-3) and np.all(extent[1] >= self.evaluated_max-1e-3), "Root framing extent excludes evaluated animation vertices")
            self.check(np.all(extent[1]-extent[0] <= (self.evaluated_max-self.evaluated_min)*1.02+.05), "Root framing extent is oversized versus evaluated vertices")
            self.report["framing"] = {"authoredExtent": extent.tolist(), "evaluatedMinimum": self.evaluated_min.tolist(), "evaluatedMaximum": self.evaluated_max.tolist()}

    def materials(self):
        source = self.source
        for prim in self.stage.Traverse():
            if not prim.IsA(UsdShade.Material):
                continue
            index = prim.GetCustomDataByKey("gltfMaterialIndex")
            if index is None:
                continue
            material = source.doc["materials"][index]
            pbr = material.get("pbrMetallicRoughness", {})
            surface = UsdShade.Shader(self.stage.GetPrimAtPath(str(prim.GetPath()) + "/Surface"))
            self.check(surface.GetIdAttr().Get() == "UsdPreviewSurface", f"material {index} has no PreviewSurface")
            unlit = "KHR_materials_unlit" in material.get("extensions", {})
            color = pbr.get("baseColorFactor", [1]*4)
            slots = [("BaseColor", pbr.get("baseColorTexture"), True, color, [0]*4)]
            if not unlit:
                slots.extend([("MetalRough", pbr.get("metallicRoughnessTexture"), False, [1, pbr.get("roughnessFactor", 1), pbr.get("metallicFactor", 1), 1], [0]*4), ("Normal", material.get("normalTexture"), False, None, None), ("Occlusion", material.get("occlusionTexture"), False, [material.get("occlusionTexture", {}).get("strength", 1), 1, 1, 1], [1-material.get("occlusionTexture", {}).get("strength", 1), 0, 0, 0])])
            emission = np.array(material.get("emissiveFactor", [0]*3))*material.get("extensions", {}).get("KHR_materials_emissive_strength", {}).get("emissiveStrength", 1)
            if not unlit:
                slots.append(("Emissive", material.get("emissiveTexture"), True, [*emission, 1], [0]*4))
            entry = {"index": index, "name": material.get("name"), "alphaMode": material.get("alphaMode", "OPAQUE"), "textures": []}
            for slot, info, srgb, factor, bias in slots:
                if not info:
                    continue
                shader = UsdShade.Shader(self.stage.GetPrimAtPath(str(prim.GetPath()) + "/" + slot))
                self.check(bool(shader), f"material {index} lost {slot} texture")
                if not shader:
                    continue
                image_index = source.doc["textures"][info["index"]]["source"]
                raw = source.image(image_index)
                packaged = self.asset(shader.GetInput("file").Get())
                a = np.array(Image.open(io.BytesIO(raw)).convert("RGBA"), dtype=float)/255
                b = np.array(Image.open(io.BytesIO(packaged)).convert("RGBA"), dtype=float)/255
                if slot != "Normal":
                    if srgb:
                        a[:, :, :3] = np.where(a[:, :, :3] <= .04045, a[:, :, :3]/12.92, ((a[:, :, :3]+.055)/1.055)**2.4)
                    a = a*np.array(factor) + np.array(bias)
                    if srgb:
                        rgb = np.maximum(a[:, :, :3], 0)
                        a[:, :, :3] = np.where(rgb <= .0031308, rgb*12.92, 1.055*rgb**(1/2.4)-.055)
                    error = self.close(b, np.clip(a, 0, 1), 1.6/255, f"material {index} {slot} decoded pixels")
                else:
                    strength = info.get("scale", 1)
                    self.close(shader.GetInput("scale").Get(), [2*strength, 2*strength, 2, 1], 1e-6, f"material {index} normal decode scale")
                    self.close(shader.GetInput("bias").Get(), [-strength, -strength, -1, 0], 1e-6, f"material {index} normal decode bias")
                    error = self.close(a, b, 0, f"material {index} normal pixels")
                    pixel_indices = np.linspace(0, a.shape[0]*a.shape[1]-1, min(64, a.shape[0]*a.shape[1])).astype(int)
                    expected_normal = (a[:, :, :3].reshape(-1, 3)[pixel_indices]*2-1)*[strength, strength, 1]
                    scale, bias = np.array(shader.GetInput("scale").Get())[:3], np.array(shader.GetInput("bias").Get())[:3]
                    decoded_normal = b[:, :, :3].reshape(-1, 3)[pixel_indices]*scale+bias
                    self.close(decoded_normal, expected_normal, 1e-6, f"material {index} directed tangent-space normal samples")
                self.check(shader.GetInput("sourceColorSpace").Get() == ("sRGB" if srgb else "raw"), f"material {index} {slot} color space")
                reader = UsdShade.Shader(self.stage.GetPrimAtPath(str(prim.GetPath()) + "/" + slot + "_UV"))
                transform = info.get("extensions", {}).get("KHR_texture_transform", {})
                uv_number = transform.get("texCoord", info.get("texCoord", 0))
                self.check(bool(reader) and reader.GetInput("varname").Get() == ("st" if uv_number == 0 else f"st{uv_number}"), f"material {index} {slot} lost texture coordinate selection")
                if transform:
                    uv_transform = UsdShade.Shader(self.stage.GetPrimAtPath(str(prim.GetPath()) + "/" + slot + "_Transform"))
                    self.check(bool(uv_transform), f"material {index} {slot} lost KHR_texture_transform")
                    if uv_transform:
                        probes = np.array([[0., 0.], [1., 0.], [0., 1.], [.37, .82]])
                        angle = float(uv_transform.GetInput("rotation").Get())*np.pi/180
                        rotation = np.array([[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]])
                        usd_input = probes * [1, -1] + [0, 1]
                        usd_uv = (usd_input*np.array(uv_transform.GetInput("scale").Get())) @ rotation.T + np.array(uv_transform.GetInput("translation").Get())
                        angle = transform.get("rotation", 0)
                        rotation = np.array([[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]])
                        gltf_uv = (probes*np.array(transform.get("scale", [1, 1]))) @ rotation.T + transform.get("offset", [0, 0])
                        self.close(usd_uv, gltf_uv*[1, -1]+[0, 1], 1e-5, f"material {index} {slot} transformed UV samples")
                connected_slot = {"BaseColor": "emissiveColor" if unlit else "diffuseColor", "MetalRough": "roughness", "Normal": "normal", "Occlusion": "occlusion", "Emissive": "emissiveColor"}[slot]
                input_shader = surface.GetInput(connected_slot)
                connection = input_shader.GetConnectedSource() if input_shader else None
                expected_channel = {"BaseColor": "rgb", "MetalRough": "g", "Normal": "rgb", "Occlusion": "r", "Emissive": "rgb"}[slot]
                self.check(connection is not None and connection[0].GetPrim() == shader.GetPrim() and connection[1] == expected_channel, f"material {index} {slot} shader connection")
                if slot == "MetalRough":
                    metallic_connection = surface.GetInput("metallic").GetConnectedSource()
                    self.check(metallic_connection is not None and metallic_connection[0].GetPrim() == shader.GetPrim() and metallic_connection[1] == "b", f"material {index} metallic texture channel")
                entry["textures"].append({"slot": slot, "sourceImage": image_index, "packageFile": shader.GetInput("file").Get().path, "maximumPixelError": error, "sha256": hashlib.sha256(packaged).hexdigest()})
            if material.get("alphaMode") in ("MASK", "BLEND"):
                opacity = surface.GetInput("opacity")
                if pbr.get("baseColorTexture"):
                    connected = opacity.GetConnectedSource() if opacity else None
                    self.check(connected is not None and str(connected[0].GetPrim().GetPath()) == str(prim.GetPath())+"/BaseColor" and connected[1] == "a", f"material {index} lost alpha texture connection")
                else:
                    self.close(opacity.Get(), color[3], 1e-6, f"material {index} alpha factor")
                if material["alphaMode"] == "MASK":
                    self.close(surface.GetInput("opacityThreshold").Get(), material.get("alphaCutoff", .5), 1e-6, f"material {index} alpha cutoff")
                else:
                    threshold = surface.GetInput("opacityThreshold")
                    self.check(not threshold or not threshold.Get() or threshold.Get() == 0, f"material {index} BLEND incorrectly uses an alpha cutoff")
            if not pbr.get("baseColorTexture"):
                self.close(surface.GetInput("emissiveColor" if unlit else "diffuseColor").Get(), color[:3], 1e-6, f"material {index} base color factor")
            if not pbr.get("metallicRoughnessTexture"):
                self.close(surface.GetInput("metallic").Get(), 0 if unlit else pbr.get("metallicFactor", 1), 1e-6, f"material {index} metallic factor")
                self.close(surface.GetInput("roughness").Get(), 1 if unlit else pbr.get("roughnessFactor", 1), 1e-6, f"material {index} roughness factor")
            self.report["materials"].append(entry)

    def audio(self):
        source = self.source
        extension = source.doc.get("extensions", {}).get("KHR_audio", {})
        scene = source.doc["scenes"][source.doc.get("scene", 0)]
        expected = []
        for e in scene.get("extensions", {}).get("KHR_audio", {}).get("emitters", []):
            emitter = extension["emitters"][e]
            for s in emitter["sources"]:
                expected.append((e, s, emitter, extension["sources"][s]))
        actual = [UsdMedia.SpatialAudio(p) for p in self.stage.Traverse() if p.IsA(UsdMedia.SpatialAudio)]
        self.check(len(actual) == len(expected), "Recorded audio emitters were omitted or duplicated")
        probe = shutil.which("ffprobe")
        self.check(not expected or bool(probe), "ffprobe is required to validate packaged audio")
        with tempfile.TemporaryDirectory(prefix="holoim-usdz-inspect-") as directory:
            for e, s, emitter, sound in expected:
                audio = UsdMedia.SpatialAudio.Get(self.stage, f"/Root/Audio_{e}_{s}")
                self.check(bool(audio), f"Recorded audio {e}/{s} is missing")
                if not audio:
                    continue
                data = self.asset(audio.GetFilePathAttr().Get())
                original = extension["audio"][sound["audio"]]
                source_file, output_file = Path(directory, "source.audio"), Path(directory, "output.m4a")
                source_file.write_bytes(source.view(original["bufferView"]))
                output_file.write_bytes(data)
                details = []
                if probe:
                    for file in (source_file, output_file):
                        result = subprocess.run([probe, "-v", "error", "-show_streams", "-show_format", "-show_packets", "-of", "json", str(file)], capture_output=True, timeout=15)
                        self.check(result.returncode == 0, f"Audio {file.name} is undecodable")
                        details.append(json.loads(result.stdout) if result.returncode == 0 else {})
                    streams = details[1].get("streams", [])
                    self.check(any(stream.get("codec_name") == "aac" for stream in streams), "Quick Look audio is not AAC")
                    durations = []
                    for detail in details:
                        packets = detail.pop("packets", [])
                        intervals = [(float(packet["pts_time"]), float(packet.get("duration_time", 0))) for packet in packets if packet.get("pts_time") not in (None, "N/A")]
                        packet_start = min((start for start, _ in intervals), default=0)
                        packet_end = max((start+duration for start, duration in intervals), default=0)
                        packet_duration = max(0, packet_end-max(0, packet_start))
                        # MediaRecorder WebM commonly has no format/stream
                        # duration. Packet PTS plus duration still describes
                        # the full media timeline; negative codec priming PTS
                        # is excluded from playable length.
                        format_duration = float(detail.get("format", {}).get("duration", 0))
                        duration = format_duration or packet_duration
                        detail["durationEvidence"] = {"method": "format.duration" if format_duration else "packet PTS end minus nonnegative start", "seconds": duration, "packetCount": len(intervals), "firstPacketPTS": packet_start, "lastPacketEnd": packet_end}
                        durations.append(duration)
                    self.check(durations[0] > 0, "Source audio duration could not be established")
                    self.check(durations[1] > 0, "Packaged audio is empty")
                    if durations[0]:
                        self.close(durations[0], durations[1], .15, "audio source/output duration seconds")
                self.check(audio.GetAuralModeAttr().Get() == "nonSpatial", "Recorded audio must remain global")
                self.check(audio.GetPlaybackModeAttr().Get() == ("loopFromStage" if sound.get("loop") else "onceFromStart"), "Audio loop behavior differs from source")
                self.close(float(audio.GetStartTimeAttr().Get().GetValue()), 0, 1e-6, "audio start time")
                self.close(audio.GetGainAttr().Get(), emitter.get("gain", 1), 1e-6, "audio gain")
                stage_duration = (self.stage.GetEndTimeCode()-self.stage.GetStartTimeCode())/self.stage.GetTimeCodesPerSecond()
                entry = {"file": audio.GetFilePathAttr().Get().path, "bytes": len(data), "mode": audio.GetPlaybackModeAttr().Get(), "probe": details, "stageDurationSeconds": stage_duration}
                if probe:
                    difference = durations[0]-stage_duration
                    entry.update({"sourceMediaDurationSeconds": durations[0], "packagedMediaDurationSeconds": durations[1], "sourceMinusStageDurationSeconds": difference, "sourceMediaMatchesAnimationDuration": abs(difference) <= .15, "synchronizationEvidence": "Original media duration is preserved without stretching; packet timing and package data do not establish physical Apple playback synchronization"})
                    if abs(difference) > .15:
                        self.report.setdefault("warnings", []).append(f"Source audio lasts {durations[0]:.3f}s while source animation/stage lasts {stage_duration:.3f}s; mismatch originates in capture and is preserved")
                self.report["audio"].append(entry)

    def run(self):
        package_bytes = Path(self.archive.filename).read_bytes()
        for name in self.archive.namelist():
            self.check(not Path(name).is_absolute() and ".." not in Path(name).parts, f"Unsafe archive path {name}")
            info = self.archive.getinfo(name)
            self.check(info.compress_type == zipfile.ZIP_STORED, f"USDZ entry is compressed: {name}")
            name_length, extra_length = struct.unpack_from("<HH", package_bytes, info.header_offset+26)
            data_offset = info.header_offset+30+name_length+extra_length
            self.check(data_offset % 64 == 0, f"USDZ entry is not 64-byte aligned: {name}")
        layer_text = self.stage.GetRootLayer().ExportToString()
        self.check(bool(re.search(r"^    autoPlay = true$", layer_text, re.M)) and bool(re.search(r'^    playbackMode = "loop"$', layer_text, re.M)), "Missing Apple top-level autoplay/loop presentation metadata")
        self.check(UsdGeom.GetStageUpAxis(self.stage) == "Y" and UsdGeom.GetStageMetersPerUnit(self.stage) == 1, "Unexpected stage units or up axis")
        self.geometry()
        self.materials()
        self.audio()
        self.report["passed"] = not self.report["failures"]
        return self.report


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(f"Usage: {sys.argv[0]} source.glb result.usdz report.json")
    inspection = None
    try:
        inspection = Inspection(sys.argv[1], sys.argv[2])
        report = inspection.run()
    except Exception as error:
        report = inspection.report if inspection else {"passed": False, "failures": []}
        report["passed"] = False
        report["failures"].append(f"Inspector failed: {type(error).__name__}: {error}")
    Path(sys.argv[3]).write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"passed": report["passed"], "failures": report["failures"], "report": sys.argv[3]}))
    sys.exit(0 if report["passed"] else 1)
