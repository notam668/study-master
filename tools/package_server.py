import os
import zipfile

rootDir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
server_dir = r'D:\server' if os.path.exists(r'D:\server') else os.path.join(rootDir, 'server')
output_zip = os.path.join(rootDir, 'server.zip')

if os.path.exists(output_zip):
    os.remove(output_zip)

exclude_dirs = {'node_modules', '.git', '__pycache__', 'banks_data', 'backups'}
exclude_exts = {'.tmp', '.log', '.bat', '.xls', '.xlsx', '.md', '.zip'}

with zipfile.ZipFile(output_zip, 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk(server_dir):
        dirs[:] = [d for d in dirs if d not in exclude_dirs]
        for f in files:
            ext = os.path.splitext(f)[1].lower()
            if ext in exclude_exts or f.startswith('.'):
                if f not in ['.dockerignore', '.env', '.env.example', '.gitignore']:
                    continue
            if f in ['{', '}', 'code.zip', 'server.zip']:
                continue
            full_path = os.path.join(root, f)
            rel_path = os.path.relpath(full_path, server_dir).replace('\\', '/')
            # 过滤非 ASCII 文件名，防止腾讯云托管 Docker BuildKit 报 gRPC invalid UTF-8
            if not all(ord(c) < 128 for c in rel_path):
                print(f"跳过非 ASCII 临时文件: {rel_path}")
                continue
            zinfo = zipfile.ZipInfo(rel_path)
            zinfo.flag_bits |= 0x800  # 显式声明 UTF-8 编码标准
            zinfo.compress_type = zipfile.ZIP_DEFLATED
            with open(full_path, 'rb') as fp:
                zf.writestr(zinfo, fp.read())

print(f'server.zip 生成成功：{output_zip} (纯正斜杠 + 纯 ASCII 路径 + 100% Linux gRPC 兼容规范)')
