# ponytail: scheme E — home overlay, app header absorbs status
from pathlib import Path

html = (Path(__file__).parent / "index.html").read_text(encoding="utf-8")
assert 'id="phoneStatus"' in html
assert "phone-status-app" in html
assert "phone-status-home" in html
assert "body.phone-status-app .cal-bar" in html
assert "body:has(#phoneStatus:not(.is-off))" not in html
assert 'toggle("is-off"' in html
print("phone-status E ok")
