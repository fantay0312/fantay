// Interface declarations adapted from jy-draftc (MIT); see licenses/jy-draftc-MIT.txt.
// No ByteDance libraries are included in this module.
#include <iostream>
#include <iterator>
#include <string>
#include <unistd.h>

namespace lvve {
class EncryptUtils {
public:
    void enable(bool);
    std::string encrypt(const std::string&);
    std::string decrypt(const std::string&, const std::string&, bool&);
};
}

int main(int argc, const char* argv[]) {
    if (argc != 2) return 2;
    const std::string mode(argv[1]);
    if (mode != "encode" && mode != "decode") return 2;
    std::string input;
    char buffer[65536];
    while (std::cin.read(buffer, sizeof(buffer)) || std::cin.gcount()) {
        input.append(buffer, static_cast<size_t>(std::cin.gcount()));
        if (input.size() > 64 * 1024 * 1024) return 3;
    }
    try {
        lvve::EncryptUtils codec;
        codec.enable(true);
        bool ok = true;
        std::string output = mode == "encode" ? codec.encrypt(input) : codec.decrypt(input, "{}", ok);
        if (!ok || output.empty() || output.size() > 64 * 1024 * 1024) return 4;
        // Official library initializers log to stdout. Use a separate pipe.
        size_t offset = 0;
        while (offset < output.size()) {
            const auto count = ::write(3, output.data() + offset, output.size() - offset);
            if (count <= 0) return 5;
            offset += static_cast<size_t>(count);
        }
        return 0;
    } catch (...) { return 6; }
}
