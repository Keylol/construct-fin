// @ts-check
/**
 * Flat-config ESLint 9 для apps/api.
 *
 * До этого линтер API молчал: в пакете стоит eslint 9, а конфига flat-формата не
 * было — шаг Lint в CI падал под `continue-on-error: true` («пока без ESLint для
 * api»), то есть правила не проверялись вообще. Для сервиса, который принимает
 * банковские токены и выписки, важны прежде всего два: никакого `console.*`
 * (пишет в обход pino, где настроены белый список полей и вычистка секретов) и
 * никакого `any` в прод-коде.
 *
 * Собран на уже установленных @typescript-eslint/{parser,eslint-plugin} —
 * без новых зависимостей.
 */
const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

/** @type {import('eslint').Linter.Config[]} */
module.exports = [
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      // Секреты и ПД пишутся в лог только через Logger/pino: там белый список
      // полей и sanitizeSecrets. console.* обходит и то, и другое.
      'no-console': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-explicit-any': 'error',
      // require() в TS обходит типизацию. В коде есть несколько обоснованных
      // исключений (CommonJS-библиотеки разбора PDF) — они уже помечены
      // точечными eslint-disable с объяснением на месте.
      '@typescript-eslint/no-require-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Тесты и харнессы: console — диагностика прогона, any — моки чужих типов.
    files: ['**/*.test.ts', 'src/test/**/*.ts', 'src/loadtest/**/*.ts', 'src/functional/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  // Для main.ts/config.ts правило НЕ отключаем скопом: там до инициализации
  // логгера писать больше некуда, но каждое такое место уже помечено точечным
  // eslint-disable с объяснением — так исключение остаётся видимым в коде.
];
