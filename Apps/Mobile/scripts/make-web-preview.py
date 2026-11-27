# Turns `npx expo export --platform web --output-dir <export>` into a page that runs from any
# host path (an artifact, a static file host under a sub-path): files resolve from the page,
# the router starts at "/" (or #live, #media, #settings, #pair), and nothing starts with "_".
# Usage: python3 scripts/make-web-preview.py <export-dir> <out-dir>
import os, re, shutil, sys, glob
src, dst = sys.argv[1], sys.argv[2]
shutil.rmtree(dst, ignore_errors=True); shutil.copytree(src, dst)
os.remove(os.path.join(dst, 'metadata.json'))
os.rename(os.path.join(dst, '_expo'), os.path.join(dst, 'expo'))
js = glob.glob(os.path.join(dst, 'expo/static/js/web/*.js'))
assert len(js) == 1, js
code = open(js[0]).read()
n = code.count('"/assets/')
code = code.replace('"/assets/', '__PM_BASE__+"assets/')
open(js[0], 'w').write(code)
rel = os.path.relpath(js[0], dst)
page = f'''<title>Pocket Monitor</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
  html, body {{ height: 100%; background: #0d0d0d; }}
  @media (prefers-color-scheme: light) {{ :root:not([data-theme="dark"]) body {{ background: #ffffff; }} }}
  :root[data-theme="light"] body {{ background: #ffffff; }}
  body {{ overflow: hidden; }}
  #root {{ display: flex; height: 100%; flex: 1; }}
</style>
<noscript>Pocket Monitor needs JavaScript.</noscript>
<div id="root"></div>
<script>
  // Files are published next to this page, so resolve them from wherever it is hosted.
  window.__PM_BASE__ = new URL('.', location.href).href;
  (function () {{
    // Navigation lives in memory if the host frame refuses history changes.
    ['pushState', 'replaceState'].forEach(function (name) {{
      var original = history[name].bind(history);
      history[name] = function () {{ try {{ return original.apply(null, arguments); }} catch (e) {{}} }};
    }});
    // Start route from a plain #name link: #live, #media, #settings, #pair.
    var routes = {{ live: '/live?demo=1', media: '/media', settings: '/settings', pair: '/pair', multiview: '/multiview?demo=4', watcher: '/watcher', server: '/server', assists: '/dev/assists' }};
    var start = routes[location.hash.slice(1)] || '/';
    history.replaceState(null, '', start);
    var bundle = document.createElement('script');
    bundle.src = window.__PM_BASE__ + '{rel}';
    document.body.appendChild(bundle);
  }})();
</script>
'''
open(os.path.join(dst, 'index.html'), 'w').write(page)
files = sorted(os.path.relpath(p, dst) for p in glob.glob(os.path.join(dst, '**/*'), recursive=True) if os.path.isfile(p))
print('rewrote', n, 'asset urls;', len(files), 'files')
for f in files: print(f)
