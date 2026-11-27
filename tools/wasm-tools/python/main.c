/* InkShell python3 (item 84): CPython's own main (Programs/python.c) plus Pillow's C modules linked in
   (WASI has no dlopen): PIL._imaging, PIL._imagingmath, PIL._imagingmorph as built-in modules. */
#include <Python.h>

PyMODINIT_FUNC PyInit__imaging(void);
PyMODINIT_FUNC PyInit__imagingmath(void);
PyMODINIT_FUNC PyInit__imagingmorph(void);

int main(int argc, char **argv) {
    PyImport_AppendInittab("PIL._imaging", PyInit__imaging);
    PyImport_AppendInittab("PIL._imagingmath", PyInit__imagingmath);
    PyImport_AppendInittab("PIL._imagingmorph", PyInit__imagingmorph);
    return Py_BytesMain(argc, argv);
}
