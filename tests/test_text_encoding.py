"""防止后续脚本重新依赖 Windows 的系统默认文本编码。"""
import ast
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class TextEncodingTests(unittest.TestCase):
    def test_text_files_and_text_subprocesses_have_explicit_encoding(self):
        for folder in ('server', 'scripts', 'research', 'tests'):
            for path in (ROOT / folder).rglob('*.py'):
                tree = ast.parse(path.read_text(encoding='utf-8'))
                for node in ast.walk(tree):
                    if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
                        continue
                    method = node.func.attr
                    keywords = {key.arg for key in node.keywords}
                    needs_encoding = method in ('read_text', 'write_text')
                    if isinstance(node.func.value, ast.Name) and node.func.value.id == 'subprocess':
                        needs_encoding = any(key.arg == 'text' and isinstance(key.value, ast.Constant) and key.value.value is True for key in node.keywords)
                    if needs_encoding:
                        with self.subTest(file=str(path.relative_to(ROOT)), line=node.lineno):
                            self.assertIn('encoding', keywords)


if __name__ == '__main__':
    unittest.main()
