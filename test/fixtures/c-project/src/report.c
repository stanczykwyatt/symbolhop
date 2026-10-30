#include <stdio.h>
#include "config.h"

/* Prints what parse_config made of a line. Old versions called this parse_config_report. */
void report(const char *line) {
    struct settings settings;
    parse_config(line, &settings);
    printf("threads=%d verbose=%d\n", settings.threads, settings.verbose);
}

/* Deliberately broken, for the diagnostics test: */
int broken(void) {
    return undefined_value;
}
