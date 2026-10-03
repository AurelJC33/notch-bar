// Raccourci clavier global : valeur par défaut et validation du format
// "Ctrl+Alt+N" (syntaxe des accélérateurs Electron). Au moins un modificateur
// est exigé : une touche seule détournerait la frappe dans toutes les apps.
const MODIFIER = '(?:Ctrl|Control|CommandOrControl|CmdOrCtrl|Alt|Shift|Super|Meta)';
const KEY = '(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Tab|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Insert|Delete|Backspace)';
const ACCELERATOR_PATTERN = new RegExp('^(?:' + MODIFIER + '\\+)+' + KEY + '$');

const DEFAULT_GLOBAL_SHORTCUT = 'Ctrl+Alt+N';

function isValidAccelerator(value) {
  return typeof value === 'string' && value.length <= 40 && ACCELERATOR_PATTERN.test(value);
}

module.exports = { DEFAULT_GLOBAL_SHORTCUT, isValidAccelerator };
