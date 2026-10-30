#ifndef CONFIG_H
#define CONFIG_H

/* A made-up settings reader, for symbolhop's tests. */
struct settings {
    int threads;
    int verbose;
};

/* Fills in settings from text like "threads=4". Returns 0 on success. */
int parse_config(const char *text, struct settings *out);
int parse_config_file(const char *path, struct settings *out);

/* Plugins can bring their own reader; this field shares the function's name. */
struct hooks {
    int (*parse_config)(const char *text, struct settings *out);
};

#endif
