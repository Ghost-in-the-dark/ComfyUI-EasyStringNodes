# my_custom_nodes.py

class ConcatenatePromptsNode:
    """
    A node that concatenates multiple input prompts into a single output prompt.
    Supports dynamic number of inputs through configuration.
    """

    @classmethod
    def INPUT_TYPES(cls):
        input_types = {"required": {}}
        
        # Добавляем динамически количество входов
        # Пользователь может легко изменить NUM_INPUTS для настройки количества входов
        cls.NUM_INPUTS = 15  # Можно изменить это значение для настройки количества входов
        
        for i in range(1, cls.NUM_INPUTS + 1):
            input_types["required"][f"prompt_{i}"] = ("STRING", {"default": f"Prompt {i}"})
            
        return input_types

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("concatenated_prompt",)
    FUNCTION = "concatenate_prompts"
    CATEGORY = "Custom"

    def concatenate_prompts(self, **kwargs):
        # Извлекаем и сортируем промпты по номеру в названии входа
        prompt_items = [
            (k, v) for k, v in kwargs.items() 
            if k.startswith('prompt_')
        ]
        
        # Сортируем по номеру входа (prompt_1, prompt_2, ...)
        sorted_prompts = sorted(
            prompt_items,
            key=lambda x: int(x[0].replace('prompt_', ''))
        )
        
        # Извлекаем только значения (сами промпты) и объединяем
        concatenated_prompt = " ".join([prompt for key, prompt in sorted_prompts])
        return (concatenated_prompt,)


# __init__.py

# A dictionary that contains all nodes you want to export with their names
# NOTE: names should be globally unique
NODE_CLASS_MAPPINGS = {
    "ConcatenatePromptsNode": ConcatenatePromptsNode,
}

# A dictionary that contains the friendly/humanly readable titles for the nodes
NODE_DISPLAY_NAME_MAPPINGS = {
    "ConcatenatePromptsNode": "Concatenate Prompts",
}
