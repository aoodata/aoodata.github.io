Translator = function(dicts, language){
        this.dicts = dicts;
        this.language = language || 'en';
        this.fallback_language = 'en';

        this.setLanguage = function(language){
            this.language = language;
        }

        this.translate = function(key){
            if(this.language in this.dicts && this.dicts[this.language][key]){
                return this.dicts[this.language][key];
            } else if(this.dicts[this.fallback_language][key]){
                return this.dicts[this.fallback_language][key];
            } else {
                return key;
            }
        }

        return this;
    };