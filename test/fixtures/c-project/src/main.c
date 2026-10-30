#include <stdio.h>
#include "config.h"

static int fake_reader(const char *text, struct settings *out) {
    (void)text;
    out->threads = 2;
    return 0;
}

int main(int argc, char **argv) {
    struct settings settings;
    struct hooks hooks = { .parse_config = fake_reader };
    if (argc > 1) {
        if (parse_config(argv[1], &settings) != 0) {
            fprintf(stderr, "parse_config failed\n");
            return 1;
        }
    } else {
        hooks.parse_config("threads=2", &settings);
    }
    printf("%d threads\n", settings.threads);
    return parse_config_file("settings.txt", &settings);
}
