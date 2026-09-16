from pathlib import Path

path = Path("energiazen-mini/app/(tabs)/index.tsx")
text = path.read_text()
start = text.index('        <Pressable\n          accessibilityHint="Avaa vedenkäyttöhistorian"')
end_marker = '        </Pressable>\n'
end = text.index(end_marker, start) + len(end_marker)
text = text[:start] + text[end:]
path.write_text(text)
