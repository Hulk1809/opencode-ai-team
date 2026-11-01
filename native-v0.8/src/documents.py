"""Bounded, offline extraction. Never execute uploaded content."""
import sys, zipfile, pathlib, json, xml.etree.ElementTree as ET, stat

path, kind = sys.argv[1:]
with zipfile.ZipFile(path) as archive:
    entries = archive.infolist()
    if len(entries) > 200:
        raise ValueError('ZIP vượt 200 entries')
    total = 0
    for entry in entries:
        name = pathlib.PurePosixPath(entry.filename.replace('\\', '/'))
        if name.is_absolute() or '..' in name.parts or ':' in entry.filename or stat.S_ISLNK(entry.external_attr >> 16):
            raise ValueError('ZIP chứa đường dẫn hoặc symlink không an toàn')
        total += entry.file_size
        if total > 16 * 1024 * 1024 or entry.file_size > 8 * 1024 * 1024:
            raise ValueError('ZIP giải nén vượt giới hạn')
        if entry.flag_bits & 1:
            raise ValueError('Không hỗ trợ ZIP mã hóa')
    if kind == 'docx':
        data = archive.read('word/document.xml')
        if b'<!DOCTYPE' in data or b'<!ENTITY' in data:
            raise ValueError('DOCX XML không an toàn')
        root = ET.fromstring(data)
        print('\n'.join(''.join(p.itertext()) for p in root.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p'))[:500000])
    else:
        # ponytail: only safe text entries are exposed; binary archive entries remain download-only.
        texts = []
        safe = {'.txt', '.md', '.json', '.csv', '.yaml', '.yml', '.java', '.ts', '.tsx', '.js', '.py', '.sql', '.xml', '.css', '.html'}
        for entry in entries:
            if not entry.is_dir() and pathlib.PurePosixPath(entry.filename).suffix.lower() in safe:
                texts.append({'name': entry.filename, 'text': archive.read(entry).decode('utf-8', errors='strict')[:50000]})
        print(json.dumps({'entries': [e.filename for e in entries], 'documents': texts}, ensure_ascii=False)[:500000])
