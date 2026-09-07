import re
from html.parser import HTMLParser

class EasyStringV2:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "input_text": ("STRING", {
                    "multiline": True,
                    "default": "1: Первая строка\n2: Вторая строка"
                }),
                "line_numbers": ("STRING", {"default": "1"}),
                "weight": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.1,
                    "max": 10.0,
                    "step": 0.1,
                    "display": "slider"
                }),
                "apply_weight": ("BOOLEAN", {"default": True}),
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

    def format_weight(self, weight):
        """Форматирует вес, избегая проблем с плавающей точкой"""
        rounded = round(weight, 2)
        if rounded.is_integer():
            return str(int(rounded))
        return f"{rounded:.2f}".rstrip('0').rstrip('.')

    def process(self, input_text, line_numbers, weight=1.0, apply_weight=True):
        # Разбиваем входной текст на строки
        lines = input_text.split('\n')
        selected_numbers = [int(n)-1 for n in re.findall(r'\d+', line_numbers)]
        all_elements = []

        # Форматируем вес один раз для всех элементов
        formatted_weight = self.format_weight(weight) if apply_weight else None

        for idx in selected_numbers:
            if idx < len(lines):
                # Очищаем строку от HTML и лишних пробелов
                clean_line = self.strip_html(lines[idx].strip())
                
                # Удаляем префикс с номером строки (например, "1: ")
                clean_line = re.sub(r'^\d+:\s*', '', clean_line)
                
                # Разбиваем на элементы по запятым
                elements = [elem.strip() for elem in clean_line.split(',')]
                elements = [elem for elem in elements if elem]  # Убираем пустые элементы

                for elem in elements:
                    # Если переключатель выключен, оставляем элемент как есть
                    if not apply_weight:
                        all_elements.append(elem)
                        continue
                    
                    # Обработка элементов с существующим весом
                    if elem.startswith('(') and elem.endswith(')'):
                        content = elem[1:-1].strip()
                        if ':' in content:
                            parts = content.rsplit(':', 1)
                            text_part = parts[0].strip()
                            weight_str = parts[1].strip()
                            
                            # Проверяем, является ли weight_str числом
                            try:
                                float(weight_str)
                                # Заменяем вес
                                new_elem = f"({text_part}:{formatted_weight})"
                            except:
                                # Если не число, добавляем новый вес
                                new_elem = f"({content}:{formatted_weight})"
                        else:
                            # Скобки есть, но нет разделителя веса
                            new_elem = f"({content}:{formatted_weight})"
                    else:
                        # Элемент без скобок
                        new_elem = f"({elem}:{formatted_weight})"
                    
                    all_elements.append(new_elem)

        # Форматируем вывод: каждый элемент с запятой после него
        formatted_elements = [f"{elem}," for elem in all_elements]
        output_text = ' '.join(formatted_elements)
        
        # Убираем последнюю запятую, если она есть
        if output_text.endswith(','):
            output_text = output_text.rstrip(',')
            
        # Убираем лишние пробелы
        output_text = re.sub(r'\s+', ' ', output_text).strip()
        
        return (output_text,)

class EasyStringSelector:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "input_text": ("STRING", {
                    "multiline": True,
                    "default": "1: Первая строка\n2: Вторая строка"
                }),
                "line_numbers": ("STRING", {"default": "1"}),
                "preset_input": ("STRING", {
                    "multiline": True,
                    "default": "1: Набор 1\n2: Набор 2",
                    "height": 100  # Уменьшенная высота для пресетов
                }),
                "use_preset": ("BOOLEAN", {"default": False}),
                "preset_line": ("INT", {
                    "default": 1,
                    "min": 1,
                    "max": 100,
                    "step": 1
                }),
                "weight": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.1,
                    "max": 10.0,
                    "step": 0.1,
                    "display": "slider"
                }),
                "apply_weight": ("BOOLEAN", {"default": True}),
            },
            "optional": {
                "preset_trigger": ("BOOLEAN", {"forceInput": True}),  # Опциональный триггер
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

    def format_weight(self, weight):
        """Форматирует вес, избегая проблем с плавающей точкой"""
        rounded = round(weight, 2)
        if rounded.is_integer():
            return str(int(rounded))
        return f"{rounded:.2f}".rstrip('0').rstrip('.')

    def process(self, input_text, line_numbers, preset_input, use_preset, preset_line, weight=1.0, apply_weight=True, preset_trigger=None):
        # Если используется пресет, заменяем line_numbers на выбранную строку из preset_input
        if use_preset:
            preset_lines = preset_input.split('\n')
            if 1 <= preset_line <= len(preset_lines):
                # Извлекаем текст выбранной строки пресета
                selected_preset = preset_lines[preset_line - 1].strip()
                
                # Удаляем префикс номера строки
                selected_preset = re.sub(r'^\d+:\s*', '', selected_preset)
                line_numbers = selected_preset
        
        # Разбиваем входной текст на строки
        lines = input_text.split('\n')
        selected_numbers = [int(n)-1 for n in re.findall(r'\d+', line_numbers)]
        all_elements = []

        # Форматируем вес один раз для всех элементов
        formatted_weight = self.format_weight(weight) if apply_weight else None

        for idx in selected_numbers:
            if idx < len(lines):
                # Очищаем строку от HTML и лишних пробелов
                clean_line = self.strip_html(lines[idx].strip())
                
                # Удаляем префикс с номером строки (например, "1: ")
                clean_line = re.sub(r'^\d+:\s*', '', clean_line)
                
                # Разбиваем на элементы по запятым
                elements = [elem.strip() for elem in clean_line.split(',')]
                elements = [elem for elem in elements if elem]  # Убираем пустые элементы

                for elem in elements:
                    # Если переключатель выключен, оставляем элемент как есть
                    if not apply_weight:
                        all_elements.append(elem)
                        continue
                    
                    # Обработка элементов с существующим весом
                    if elem.startswith('(') and elem.endswith(')'):
                        content = elem[1:-1].strip()
                        if ':' in content:
                            parts = content.rsplit(':', 1)
                            text_part = parts[0].strip()
                            weight_str = parts[1].strip()
                            
                            # Проверяем, является ли weight_str числом
                            try:
                                float(weight_str)
                                # Заменяем вес
                                new_elem = f"({text_part}:{formatted_weight})"
                            except:
                                # Если не число, добавляем новый вес
                                new_elem = f"({content}:{formatted_weight})"
                        else:
                            # Скобки есть, но нет разделителя веса
                            new_elem = f"({content}:{formatted_weight})"
                    else:
                        # Элемент без скобок
                        new_elem = f"({elem}:{formatted_weight})"
                    
                    all_elements.append(new_elem)

        # Форматируем вывод: каждый элемент с запятой после него
        formatted_elements = [f"{elem}," for elem in all_elements]
        output_text = ' '.join(formatted_elements)
        
        # Убираем последнюю запятую, если она есть
        if output_text.endswith(','):
            output_text = output_text.rstrip(',')
            
        # Убираем лишние пробелы
        output_text = re.sub(r'\s+', ' ', output_text).strip()
        
        return (output_text,)

class EasyStringSelectorNeg:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "input_text": ("STRING", {
                    "multiline": True,
                    "default": "1: Первая строка --- негатив\n2: Вторая строка"
                }),
                "line_numbers": ("STRING", {"default": "1"}),
                "preset_input": ("STRING", {
                    "multiline": True,
                    "default": "1: Набор 1\n2: Набор 2",
                    "height": 100
                }),
                "use_preset": ("BOOLEAN", {"default": False}),
                "preset_line": ("INT", {
                    "default": 1,
                    "min": 1,
                    "max": 100,
                    "step": 1
                }),
                "weight": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.1,
                    "max": 10.0,
                    "step": 0.1,
                    "display": "slider"
                }),
                "apply_weight": ("BOOLEAN", {"default": True}),
                "add_break": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "preset_trigger": ("BOOLEAN", {"forceInput": True}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("positive_prompt", "negative_prompt")
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

    def format_weight(self, weight):
        rounded = round(weight, 2)
        if rounded.is_integer():
            return str(int(rounded))
        return f"{rounded:.2f}".rstrip('0').rstrip('.')

    def process_elements(self, elements, apply_weight, formatted_weight):
        processed = []
        for elem in elements:
            if not apply_weight:
                processed.append(elem)
                continue
            
            if elem.startswith('(') and elem.endswith(')'):
                content = elem[1:-1].strip()
                if ':' in content:
                    parts = content.rsplit(':', 1)
                    text_part = parts[0].strip()
                    weight_str = parts[1].strip()
                    try:
                        float(weight_str)
                        new_elem = f"({text_part}:{formatted_weight})"
                    except:
                        new_elem = f"({content}:{formatted_weight})"
                else:
                    new_elem = f"({content}:{formatted_weight})"
            else:
                new_elem = f"({elem}:{formatted_weight})"
            processed.append(new_elem)
        return processed

    def format_output(self, elements):
        formatted = [f"{elem}," for elem in elements]
        output = ' '.join(formatted)
        if output.endswith(','):
            output = output.rstrip(',')
        return re.sub(r'\s+', ' ', output).strip()

    def process(self, input_text, line_numbers, preset_input, use_preset, preset_line, weight=1.0, apply_weight=True, preset_trigger=None, add_break=False):
        if use_preset:
            preset_lines = preset_input.split('\n')
            if 1 <= preset_line <= len(preset_lines):
                selected_preset = preset_lines[preset_line - 1].strip()
                selected_preset = re.sub(r'^\d+:\s*', '', selected_preset)
                line_numbers = selected_preset
        
        lines = input_text.split('\n')
        selected_numbers = [int(n)-1 for n in re.findall(r'\d+', line_numbers)]
        all_positive = []
        all_negative = []
        
        formatted_weight = self.format_weight(weight) if apply_weight else None

        for idx in selected_numbers:
            if idx < len(lines):
                line = lines[idx].strip()
                
                # Разделение на основной и негативный промпты
                if '---' in line:
                    pos_line, neg_line = line.split('---', 1)
                else:
                    pos_line = line
                    neg_line = ""

                # Обработка основного промпта
                pos_clean = self.strip_html(pos_line.strip())
                pos_clean = re.sub(r'^\d+:\s*', '', pos_clean)
                pos_elements = [elem.strip() for elem in pos_clean.split(',') if elem.strip()]
                all_positive.extend(self.process_elements(pos_elements, apply_weight, formatted_weight))
                
                # Обработка негативного промпта
                if neg_line:
                    neg_clean = self.strip_html(neg_line.strip())
                    neg_clean = re.sub(r'^\d+:\s*', '', neg_clean)
                    neg_elements = [elem.strip() for elem in neg_clean.split(',') if elem.strip()]
                    all_negative.extend(self.process_elements(neg_elements, apply_weight, formatted_weight))

        # Форматирование вывода
        positive_output = self.format_output(all_positive)
        negative_output = self.format_output(all_negative) if all_negative else ""
        
        # Добавляем BREAK в конец позитивного промпта при необходимости
        if add_break and positive_output:
            positive_output += " BREAK"

        return (positive_output, negative_output)
        
NODE_CLASS_MAPPINGS = {
    "EasyStringV2": EasyStringV2,
    "EasyStringSelector": EasyStringSelector,
    "EasyStringSelectorNeg": EasyStringSelectorNeg
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "EasyStringV2": "Easy String V2",
    "EasyStringSelector": "Easy String Selector",
    "EasyStringSelectorNeg": "Easy String Selector Neg"
}
