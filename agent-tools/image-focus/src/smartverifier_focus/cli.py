import argparse
import json
import sys

from .core import FocusError, ImageWorkspace


def main():
    parser = argparse.ArgumentParser(description="Local, non-generative crop/rotate/resize tools for inspection agents")
    parser.add_argument("--workspace", required=True, help="Private image workspace directory")
    sub = parser.add_subparsers(dest="command", required=True)
    ingest = sub.add_parser("import", help="Import a photo (trusted host operation)")
    ingest.add_argument("path")
    for name in ["inspect", "focus", "rotate", "tiles", "map"]:
        cmd = sub.add_parser(name)
        cmd.add_argument("arguments", help="JSON object matching the tool arguments")
    args = parser.parse_args()
    try:
        workspace = ImageWorkspace(args.workspace)
        if args.command == "import":
            result = workspace.import_image(args.path)
        else:
            arguments = json.loads(args.arguments)
            if not isinstance(arguments, dict):
                raise FocusError("Tool arguments must be a JSON object")
            names = {"inspect": "inspect_image", "focus": "focus_image", "rotate": "rotate_image", "tiles": "tile_image", "map": "map_focus_region"}
            result = getattr(workspace, names[args.command])(**arguments)
        print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
    except (FocusError, TypeError, json.JSONDecodeError, OSError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
