"""InkShell (item 86): some Pillow methods (METH_NOARGS, and two METH_VARARGS ones) are written with one parameter
(self) and cast to PyCFunction, which CPython calls with two (self, NULL or args). Native code does not care; WebAssembly traps ("indirect call type mismatch":
e.g. Image.getextrema(), split(), WEBP open). Give each such function the unused second parameter, as CPython's own
modules do. Idempotent. usage: python3 fix_meth.py pillow/src"""
import pathlib
import re
import sys

src = pathlib.Path(sys.argv[1])
files = sorted(src.glob('*.c')) + sorted(src.glob('libImaging/*.c'))
noargs = set()
for f in files:
    noargs.update(re.findall(r'\(PyCFunction\)\s*(\w+)\s*,\s*METH_(?:NOARGS|VARARGS|O)\b(?!\s*\|)', f.read_text()))
fixed = []
for f in files:
    t = f.read_text()
    n = t
    for name in noargs:  # a definition at the start of a line: name(Type *self) {
        n = re.sub(r'(?m)^(%s\(\s*[\w ]+\*\s*\w+)\)(\s*\{)' % re.escape(name), r'\1, PyObject *Py_UNUSED(ink_noargs))\2', n)
    if n != t:
        f.write_text(n)
        fixed.append(f.name)
print('fix_meth: methods', len(noargs), 'files changed', fixed)
