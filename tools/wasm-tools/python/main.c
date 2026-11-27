/* InkShell python3 (items 84, 86): CPython's own main (Programs/python.c) plus Pillow's C modules linked in
   (WASI has no dlopen): PIL._imaging, PIL._imagingft (FreeType), PIL._webp, PIL._imagingmath, PIL._imagingmorph
   as built-in modules. */
#include <Python.h>

PyMODINIT_FUNC PyInit__imaging(void);
PyMODINIT_FUNC PyInit__imagingft(void);
PyMODINIT_FUNC PyInit__webp(void);
PyMODINIT_FUNC PyInit__imagingmath(void);
PyMODINIT_FUNC PyInit__imagingmorph(void);

int main(int argc, char **argv) {
    PyImport_AppendInittab("PIL._imaging", PyInit__imaging);
    PyImport_AppendInittab("PIL._imagingft", PyInit__imagingft);
    PyImport_AppendInittab("PIL._webp", PyInit__webp);
    PyImport_AppendInittab("PIL._imagingmath", PyInit__imagingmath);
    PyImport_AppendInittab("PIL._imagingmorph", PyInit__imagingmorph);
    return Py_BytesMain(argc, argv);
}
