import { getTheme, getAllThemes, DEFAULT_THEME_ID } from '../lib/themes';

describe('themes', () => {
  test('getAllThemes returns exactly 4 themes', () => {
    const themes = getAllThemes();
    expect(themes).toHaveLength(4);
  });

  test('each theme has required xterm ITheme fields', () => {
    const themes = getAllThemes();
    for (const theme of themes) {
      expect(theme).toHaveProperty('id');
      expect(theme).toHaveProperty('name');
      expect(theme).toHaveProperty('colors.background');
      expect(theme).toHaveProperty('colors.foreground');
      expect(theme).toHaveProperty('colors.cursor');
      expect(theme).toHaveProperty('colors.selectionBackground');
    }
  });

  test('getTheme returns correct theme by id', () => {
    const dracula = getTheme('dracula');
    expect(dracula).not.toBeNull();
    expect(dracula!.name).toBe('Dracula');
    expect(dracula!.colors.background).toBe('#282a36');
  });

  test('getTheme returns null for unknown id', () => {
    expect(getTheme('nonexistent')).toBeNull();
  });

  test('DEFAULT_THEME_ID points to a valid theme', () => {
    const theme = getTheme(DEFAULT_THEME_ID);
    expect(theme).not.toBeNull();
  });
});
