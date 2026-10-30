#include <stdio.h>
#include <string.h>
#include "config.h"

int parse_config(const char *text, struct settings *out) {
    out->threads = 1;
    out->verbose = 0;
    if (strstr(text, "threads=")) out->threads = text[8] - '0';
    if (strstr(text, "verbose")) out->verbose = 1;
    return 0;
}

int parse_config_file(const char *path, struct settings *out) {
    char text[256] = {0};
    FILE *file = fopen(path, "r");
    if (!file) return -1;
    fread(text, 1, sizeof text - 1, file);
    fclose(file);
    return parse_config(text, out);
}
