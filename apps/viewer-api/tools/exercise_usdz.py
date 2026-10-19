#!/usr/bin/env python3
"""Source-derived conversion challenges complementing the real capture pipeline.

Run after the pipeline: exercise_usdz.py captured.glb artifact-directory.
Each case remains a complete self-contained GLB, and runs the production CLI
plus the independent inspector. Cases target failure modes absent in walking
capture: changing facial weights, transformed ancestors/bind space, no audio,
unsupported required extensions, and invalid audio preserving the source.
"""

import copy
import hashlib
import io
import json
from pathlib import Path
import struct
import subprocess
import sys

import numpy as np
from PIL import Image


def read_glb(path):
    raw = Path(path).read_bytes()
    offset, document, binary = 12, None, b""
    while offset < len(raw):
        length, kind = struct.unpack_from("<I4s", raw, offset)
        payload = raw[offset+8:offset+8+length]
        if kind == b"JSON":
            document = json.loads(payload)
        elif kind == b"BIN\0":
            binary = payload
        offset += length+8
    return document, bytearray(binary)


def write_glb(path, doc, binary):
    doc["buffers"][0]["byteLength"] = len(binary)
    data = json.dumps(doc, separators=(",", ":")).encode()
    data += b" " * (-len(data) % 4)
    blob = bytes(binary) + b"\0" * (-len(binary) % 4)
    Path(path).write_bytes(struct.pack("<4sII", b"glTF", 2, 28+len(data)+len(blob)) + struct.pack("<I4s", len(data), b"JSON") + data + struct.pack("<I4s", len(blob), b"BIN\0") + blob)


def floats(doc, binary, values, kind):
    binary.extend(b"\0" * (-len(binary) % 4))
    offset = len(binary)
    array = np.asarray(values, dtype="<f4")
    binary.extend(array.tobytes())
    view = len(doc.setdefault("bufferViews", []))
    doc["bufferViews"].append({"buffer": 0, "byteOffset": offset, "byteLength": array.nbytes})
    accessor = len(doc.setdefault("accessors", []))
    width = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}[kind]
    doc["accessors"].append({"bufferView": view, "componentType": 5126, "count": array.size//width, "type": kind})
    return accessor


def challenge(doc, binary):
    scene = doc["scenes"][doc.get("scene", 0)]
    roots = list(scene["nodes"])
    index = len(doc["nodes"])
    doc["nodes"].append({"name": "InspectorChallengeAncestor", "children": roots, "translation": [.23, .11, -.17], "rotation": [0, .1305261922, 0, .9914448614], "scale": [1.07]*3})
    scene["nodes"] = [index]
    animation = doc.setdefault("animations", [])
    if not animation:
        animation.append({"name": "RecordedMotion", "samplers": [], "channels": []})
    clip = animation[0]
    # Infer duration from source input accessors' declared max when available;
    # decode sparse-free float time accessors directly as fallback.
    end = 0
    for sampler in clip["samplers"]:
        a = doc["accessors"][sampler["input"]]
        v = doc["bufferViews"][a["bufferView"]]
        times = np.frombuffer(binary, dtype="<f4", count=a["count"], offset=v.get("byteOffset", 0)+a.get("byteOffset", 0)).copy()
        end = max(end, float(times[-1]))
    end = end or 1.0
    # Motion on an ancestor is deliberately outside the original skin.joints.
    input_accessor = floats(doc, binary, [0, end/2, end], "SCALAR")
    output = floats(doc, binary, [[.23, .11, -.17], [.37, .19, -.09], [.28, .14, -.21]], "VEC3")
    clip["channels"].append({"sampler": len(clip["samplers"]), "target": {"node": index, "path": "translation"}})
    clip["samplers"].append({"input": input_accessor, "output": output, "interpolation": "LINEAR"})
    morph_nodes = []
    for node_index, node in enumerate(doc["nodes"]):
        if "mesh" not in node:
            continue
        mesh = doc["meshes"][node["mesh"]]
        count = max((len(p.get("targets", [])) for p in mesh["primitives"]), default=0)
        if not count:
            continue
        values = np.zeros((3, count), dtype=float)
        values[0, 0] = .15
        values[1, 0] = .75
        values[2, 0] = .25
        if count > 1:
            values[:, 1] = [.6, .1, .45]
        node["weights"] = [.3] + [0]*(count-1)
        output = floats(doc, binary, values, "SCALAR")
        clip["channels"] = [c for c in clip["channels"] if not (c["target"].get("node") == node_index and c["target"].get("path") == "weights")]
        clip["channels"].append({"sampler": len(clip["samplers"]), "target": {"node": node_index, "path": "weights"}})
        clip["samplers"].append({"input": input_accessor, "output": output, "interpolation": "LINEAR"})
        morph_nodes.append(node_index)
    if not morph_nodes:
        raise ValueError("Source must contain actual avatar morph-bearing meshes")
    return {"transformedAncestor": index, "animatedMorphNodes": morph_nodes, "duration": end}


def silent(doc):
    doc.get("extensions", {}).pop("KHR_audio", None)
    for scene in doc["scenes"]:
        scene.get("extensions", {}).pop("KHR_audio", None)
    for key in ("extensionsRequired", "extensionsUsed"):
        doc[key] = [name for name in doc.get(key, []) if name != "KHR_audio"]


def material_challenge(doc, binary):
    """Exercise transparency and factors absent from the actual opaque avatar."""
    selected = []
    materials = doc.get("materials", [])
    # Prefer actual hair/eye assets, retaining their source RGB detail.
    candidates = sorted(range(len(materials)), key=lambda i: (not any(word in materials[i].get("name", "").lower() for word in ("hair", "eye")), i))
    for material_index in candidates:
        material = materials[material_index]
        pbr = material.get("pbrMetallicRoughness", {})
        info = pbr.get("baseColorTexture")
        if not info:
            continue
        texture = copy.deepcopy(doc["textures"][info["index"]])
        source_image = doc["images"][texture["source"]]
        if "bufferView" not in source_image:
            continue
        view = doc["bufferViews"][source_image["bufferView"]]
        start = view.get("byteOffset", 0)
        image = Image.open(io.BytesIO(bytes(binary[start:start+view["byteLength"]]))).convert("RGBA")
        pixels = np.array(image)
        # Opaque, translucent, and cutout texels, including alpha under MASK's
        # threshold after the nonunit alpha factor is applied.
        pixels[:, :, 3] = np.array([0, 64, 191, 255], dtype=np.uint8)[np.arange(image.width)*4//image.width][None, :]
        encoded = io.BytesIO()
        Image.fromarray(pixels).save(encoded, format="PNG")
        data = encoded.getvalue()
        binary.extend(b"\0" * (-len(binary) % 4))
        view_index = len(doc["bufferViews"])
        doc["bufferViews"].append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(data)})
        binary.extend(data)
        texture["source"] = len(doc["images"])
        doc["images"].append({"bufferView": view_index, "mimeType": "image/png", "name": f"InspectorAlpha_{material_index}"})
        info["index"] = len(doc["textures"])
        doc["textures"].append(texture)
        transform = {"offset": [.17, -.12], "scale": [.83, 1.21], "rotation": .37}
        info.setdefault("extensions", {})["KHR_texture_transform"] = transform
        material["alphaMode"] = "MASK" if not selected else "BLEND"
        if material["alphaMode"] == "MASK":
            material["alphaCutoff"] = .33
        pbr["baseColorFactor"] = [.73, .56, .91, .64]
        pbr["roughnessFactor"], pbr["metallicFactor"] = .31, .27
        pbr["metallicRoughnessTexture"] = copy.deepcopy(info)
        material["occlusionTexture"] = {**copy.deepcopy(info), "strength": .42}
        material["emissiveTexture"] = copy.deepcopy(info)
        material["emissiveFactor"] = [.07, .13, .19]
        material.setdefault("extensions", {})["KHR_materials_emissive_strength"] = {"emissiveStrength": 2.3}
        if material.get("normalTexture"):
            material["normalTexture"]["scale"] = .65
            material["normalTexture"].setdefault("extensions", {})["KHR_texture_transform"] = copy.deepcopy(transform)
        selected.append({"material": material_index, "name": material.get("name"), "alphaMode": material["alphaMode"], "sourceAlphaBytes": [0, 64, 191, 255], "baseColorFactor": pbr["baseColorFactor"], "textureTransform": transform, "normalScale": material.get("normalTexture", {}).get("scale")})
        if len(selected) == 2:
            break
    if len(selected) != 2:
        raise ValueError("Source needs two embedded base color materials for alpha challenges")
    for extension in ("KHR_texture_transform", "KHR_materials_emissive_strength"):
        if extension not in doc.setdefault("extensionsUsed", []):
            doc["extensionsUsed"].append(extension)
    return selected


def main(source, directory):
    directory.mkdir(parents=True, exist_ok=True)
    tools = Path(__file__).resolve().parent
    doc, binary = read_glb(source)
    result = {"passed": True, "source": str(source), "cases": [], "failureModes": ["lost parent/bind transforms", "omitted dynamic facial weights", "audio required for silent recording", "lost MASK/BLEND alpha, texture transforms or material factors", "silently accepted required extension", "failed conversion damages GLB or leaves complete-looking output"]}
    challenged, challenged_binary = copy.deepcopy(doc), bytearray(binary)
    provenance = challenge(challenged, challenged_binary)
    cases = [("animated-ancestor-and-face", False, False, False), ("silent-animated-ancestor-and-face", True, False, False), ("alpha-uv-pbr-animated-ancestor-and-face", False, False, True)]
    if doc.get("extensions", {}).get("KHR_audio"):
        cases.append(("once-audio-animated-ancestor-and-face", False, True, False))
    for name, no_audio, once_audio, materials in cases:
        document = copy.deepcopy(challenged)
        case_binary = bytearray(challenged_binary)
        case_provenance = copy.deepcopy(provenance)
        if materials:
            case_provenance["materials"] = material_challenge(document, case_binary)
        if no_audio:
            silent(document)
        if once_audio:
            extension = document["extensions"]["KHR_audio"]
            for sound in extension["sources"]:
                sound["loop"] = False
            for emitter in extension["emitters"]:
                emitter["gain"] = .35
        glb, usdz, report = directory/f"{name}.glb", directory/f"{name}.usdz", directory/f"{name}.json"
        write_glb(glb, document, case_binary)
        conversion = subprocess.run([sys.executable, str(tools/"glb_to_usdz.py"), str(glb), str(usdz)], capture_output=True, text=True, timeout=240)
        inspection = subprocess.run([sys.executable, str(tools/"inspect_usdz.py"), str(glb), str(usdz), str(report)], capture_output=True, text=True, timeout=180) if conversion.returncode == 0 else None
        passed = conversion.returncode == 0 and inspection is not None and inspection.returncode == 0
        result["cases"].append({"case": name, "passed": passed, "provenance": case_provenance, "glb": str(glb), "usdz": str(usdz), "report": str(report), "conversionLog": conversion.stdout+conversion.stderr, "inspectionLog": inspection.stdout+inspection.stderr if inspection else None})
        result["passed"] &= passed
    document = copy.deepcopy(doc)
    document.setdefault("extensionsRequired", []).append("EXT_inspector_unsupported_required")
    for name, document in [("unsupported-required-extension", document)]:
        glb, usdz = directory/f"{name}.glb", directory/f"{name}.usdz"
        write_glb(glb, document, binary)
        before = hashlib.sha256(glb.read_bytes()).hexdigest()
        conversion = subprocess.run([sys.executable, str(tools/"glb_to_usdz.py"), str(glb), str(usdz)], capture_output=True, text=True, timeout=240)
        passed = conversion.returncode != 0 and not usdz.exists() and hashlib.sha256(glb.read_bytes()).hexdigest() == before and "Unsupported required" in conversion.stderr
        result["cases"].append({"case": name, "passed": passed, "conversionLog": conversion.stdout+conversion.stderr, "sourcePreserved": hashlib.sha256(glb.read_bytes()).hexdigest() == before})
        result["passed"] &= passed
    extension = doc.get("extensions", {}).get("KHR_audio")
    if extension and extension.get("audio"):
        document, corrupt = copy.deepcopy(doc), bytearray(binary)
        for audio in extension["audio"]:
            view = doc["bufferViews"][audio["bufferView"]]
            start = view.get("byteOffset", 0)
            corrupt[start:start+view["byteLength"]] = b"\0" * view["byteLength"]
        glb, usdz = directory/"invalid-audio.glb", directory/"invalid-audio.usdz"
        write_glb(glb, document, corrupt)
        before = hashlib.sha256(glb.read_bytes()).hexdigest()
        conversion = subprocess.run([sys.executable, str(tools/"glb_to_usdz.py"), str(glb), str(usdz)], capture_output=True, text=True, timeout=240)
        passed = conversion.returncode != 0 and not usdz.exists() and hashlib.sha256(glb.read_bytes()).hexdigest() == before
        result["cases"].append({"case": "invalid-audio", "passed": passed, "sourcePreserved": hashlib.sha256(glb.read_bytes()).hexdigest() == before, "conversionLog": conversion.stdout+conversion.stderr})
        result["passed"] &= passed
    (directory/"exercise-summary.json").write_text(json.dumps(result, indent=2)+"\n")
    print(json.dumps({"passed": result["passed"], "cases": [{"case": c["case"], "passed": c["passed"]} for c in result["cases"]], "report": str(directory/"exercise-summary.json")}))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(f"Usage: {sys.argv[0]} captured.glb artifact-directory")
    sys.exit(main(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()))
