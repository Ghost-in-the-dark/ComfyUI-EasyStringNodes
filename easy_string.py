import re
from html.parser import HTMLParser  # Правильный импорт для Python 3

class EasyString:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "input_text": ("STRING", {
                    "multiline": True,
                    "default": "1: Первая строка\n2: Вторая строка"  # Упрощенная нумерация
                }),
                "line_numbers": ("STRING", {"default": "1"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("output_text",)
    FUNCTION = "process"
    CATEGORY = "text processing"

    def strip_html(self, text):
        class MLStripper(HTMLParser):
            def __init__(self):
                super().__init__()
                self.strict = False
                self.convert_charrefs = True
                self.text = []
            def handle_data(self, d):
                self.text.append(d)
            def get_data(self):
                return ''.join(self.text)

        stripper = MLStripper()
        stripper.feed(text)
        return stripper.get_data()

    def process(self, input_text, line_numbers):
        # Автоматическая нумерация строк
        lines = []
        for i, line in enumerate(input_text.split('\n'), 1):
            lines.append(f"{i}: {line.split(': ')[-1]}")  # Обновляем нумерацию
            
        # Удаление старой HTML-разметки (если есть)
        clean_text = self.strip_html('\n'.join(lines))
        
        # Обработка выбранных строк
        selected_numbers = [int(n)-1 for n in re.findall(r'\d+', line_numbers)]
        valid_lines = [line.split(': ', 1)[1] for idx, line in enumerate(clean_text.split('\n')) 
                      if idx in selected_numbers and idx < len(lines)]
        
        return (' '.join(valid_lines),)

NODE_CLASS_MAPPINGS = {"EasyString": EasyString}
NODE_DISPLAY_NAME_MAPPINGS = {"EasyString": "easy_string"}
