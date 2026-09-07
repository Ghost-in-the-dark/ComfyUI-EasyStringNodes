# ComfyUI Easy String Nodes (на русском)

Набор лёгких текстовых узлов для [ComfyUI](https://github.com/comfyanonymous/ComfyUI) без внешних зависимостей: выбор строк из многострочного текста, добавление весов в синтаксисе `(тег:вес)`, разделение на позитивный/негативный промпты и объединение промптов.

Все узлы написаны на чистом Python (только стандартная библиотека) — дополнительные пакеты не требуются.

[English version](README.md) | Русская версия

## Узлы

| Узел | Имя в интерфейсе | Категория | Описание |
| --- | --- | --- | --- |
| `EasyString` | easy_string | Text Processing | Выбор конкретных строк из нумерованного многострочного текста |
| `EasyStringV2` | Easy String V2 | Text Processing | Выбор строк и перевзвешивание каждого элемента через запятую в `(текст:вес)` |
| `EasyStringSelector` | Easy String Selector | Text Processing | V2 + выбор строк через пресеты |
| `EasyStringSelectorNeg` | Easy String Selector Neg | Text Processing | Разделение каждой строки на позитивный и негативный промпты |
| `ConcatenatePromptsNode` | Concatenate Prompts | Custom | Объединение до 15 промптов в одну строку |

## Установка

### Через ComfyUI Manager (рекомендуется)
Откройте **ComfyUI Manager → Install Custom Nodes**, найдите `Easy String Nodes` и перезапустите ComfyUI.

### Вручную
```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Ghost-in-the-dark/ComfyUI-EasyStringNodes.git
```

Перезапустите ComfyUI. Узлы появятся в меню в категории **Text Processing** (а *Concatenate Prompts* — в **Custom**).

Для локального использования публикация не нужна; файл `pyproject.toml` добавлен, чтобы репозиторий можно было опубликовать в [ComfyUI Registry](https://docs.comfy.org/registry/).

---

## EasyString

Выбор конкретных строк из нумерованного многострочного текста.

**Входы**

| Вход | Тип | По умолчанию |
| --- | --- | --- |
| `input_text` | STRING (многострочный) | нумерованные строки, напр. `1: кот` … |
| `line_numbers` | STRING | `1` |

**Выход:** `output_text` (STRING) — выбранные строки, объединённые пробелами.

*Пример:* вход `1: кот\n2: пёс\n3: птица`, `line_numbers` = `1,3` → выход `кот птица`.

> HTML-разметка внутри строк удаляется, а нумерация строк заново проставляется до выбора, поэтому текст, вставленный из браузера, остаётся чистым.

## EasyStringV2

Как *EasyString*, но дополнительно разбивает каждую выбранную строку на элементы через запятую и переписывает их в синтаксисе весов ComfyUI.

**Входы**

| Вход | Тип | По умолчанию |
| --- | --- | --- |
| `input_text` | STRING (многострочный) | нумерованные строки |
| `line_numbers` | STRING | `1` |
| `weight` | FLOAT (слайдер 0.1–10.0) | `1.0` |
| `apply_weight` | BOOLEAN | `true` |

**Выход:** `output_text` (STRING)

Поведение:

- Если `apply_weight` **включён**, каждый элемент превращается в `(текст:вес)`. Элементы, уже имеющие числовой вес — `(текст:1.5)`, — сохраняют текст, но получают новый вес.
- Если `apply_weight` **выключен**, элементы выдаются как есть (только очищенные).
- Префикс номера строки `N:` убирается из каждой выбранной строки.

*Пример (apply_weight = true, weight = 1.2):* вход `1: кот, пёс\n2: птица`, `line_numbers` = `1` → выход `(кот:1.2), (пёс:1.2)`.

## EasyStringSelector

Все возможности *EasyStringV2* плюс *пресеты*: второе многострочное поле, где каждая нумерованная строка хранит набор номеров строк, так что активный выбор переключается одним числом `preset_line`.

**Входы**

| Вход | Тип | По умолчанию |
| --- | --- | --- |
| `input_text` | STRING (многострочный) | нумерованные строки |
| `line_numbers` | STRING | `1` |
| `preset_input` | STRING (многострочный) | строки пресетов `1: …` |
| `use_preset` | BOOLEAN | `false` |
| `preset_line` | INT (1–100) | `1` |
| `weight` | FLOAT (слайдер) | `1.0` |
| `apply_weight` | BOOLEAN | `true` |
| `preset_trigger` (опционально) | BOOLEAN (вход) | — |

**Выход:** `output_text` (STRING)

*Пример:* строка пресета `2: 1,3` означает «использовать строки 1 и 3 из `input_text`». При `use_preset = true` и `preset_line = 2` узел выберет строки 1 и 3 из `input_text`.

## EasyStringSelectorNeg

Выбирает строки как остальные узлы, но каждую выбранную строку делит по разделителю `---` на **позитивную** и **негативную** части, отдавая оба промпта отдельными выходами.

**Входы**

| Вход | Тип | По умолчанию |
| --- | --- | --- |
| `input_text` | STRING (многострочный) | `1: … --- …` |
| `line_numbers` | STRING | `1` |
| `preset_input` | STRING (многострочный) | строки пресетов |
| `use_preset` | BOOLEAN | `false` |
| `preset_line` | INT (1–100) | `1` |
| `weight` | FLOAT (слайдер) | `1.0` |
| `apply_weight` | BOOLEAN | `true` |
| `add_break` | BOOLEAN | `false` |
| `preset_trigger` (опционально) | BOOLEAN (вход) | — |

**Выходы:** `positive_prompt` (STRING), `negative_prompt` (STRING)

Поведение:

- Каждая выбранная строка может содержать `позитив --- негатив`; часть до первого `---` идёт в позитивный выход, после — в негативный. Строки без `---` дают только позитивный элемент.
- Взвешивание работает так же, как в *EasyStringV2*, для обоих выходов.
- `add_break = true` добавляет ` BREAK` в конец позитивного выхода (игнорируется, если позитив пуст).

*Пример (apply_weight = true, weight = 1.0):* вход `1: кот --- пёс\n2: птица --- рыба`, `line_numbers` = `1,2` → позитив `(кот:1), (птица:1)`, негатив `(пёс:1), (рыба:1)`.

## ConcatenatePromptsNode

Соединяет любое количество промптов в одну строку через пробел.

**Входы:** `prompt_1` … `prompt_15` (STRING). Все входы видны всегда; пустые просто ничего не добавляют.

**Выход:** `concatenated_prompt` (STRING)

**Как изменить количество входов:** отредактируйте `NUM_INPUTS` в начале файла `Concatenate_prompts.py` и перезапустите ComfyUI:

```python
class ConcatenatePromptsNode:
    NUM_INPUTS = 15  # измените это значение
```

## Примеры workflow

Готовые примеры в API-формате лежат в [examples/workflows](examples/workflows):

- `easy_string_select_lines.json` — *EasyString*, выбор строк 1 и 3
- `easy_string_v2_weighted.json` — *EasyStringV2*, взвешивание элементов одной строки
- `selector_neg_positive_negative.json` — *EasyStringSelectorNeg*, разделение на позитив/негатив с весами

Загрузите их через загрузчик workflow в **API-формате** ComfyUI либо отправьте JSON на эндпоинт `/prompt`.

## Лицензия

MIT — см. [LICENSE](LICENSE).

## Автор

[Ваш GitHub-ник](https://github.com/Ghost-in-the-dark)