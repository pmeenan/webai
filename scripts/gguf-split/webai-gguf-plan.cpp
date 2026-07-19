#include "ggml.h"
#include "gguf.h"

#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

template <typename T>
void write_scalar(std::ofstream & out, T value) {
    out.write(reinterpret_cast<const char *>(&value), sizeof(value));
}

struct gguf_deleter {
    void operator()(gguf_context * value) const { gguf_free(value); }
};

struct ggml_deleter {
    void operator()(ggml_context * value) const { ggml_free(value); }
};

struct tensor_plan {
    uint64_t input_offset;
    uint64_t length;
    uint32_t split;
    uint64_t output_offset;
};

} // namespace

int main(int argc, const char ** argv) {
    if (argc != 5) {
        return 2;
    }
    const uint64_t split_max_bytes = std::strtoull(argv[4], nullptr, 10);
    if (split_max_bytes < 32 || split_max_bytes > 2000000000) {
        return 9;
    }

    ggml_context * raw_meta = nullptr;
    gguf_init_params params = { true, &raw_meta };
    std::unique_ptr<gguf_context, gguf_deleter> input(gguf_init_from_file(argv[1], params));
    std::unique_ptr<ggml_context, ggml_deleter> meta(raw_meta);
    if (!input || !meta) {
        return 3;
    }

    const int64_t tensor_count = gguf_get_n_tensors(input.get());
    if (tensor_count < 1 || tensor_count > 1000000) {
        return 4;
    }

    std::vector<std::unique_ptr<gguf_context, gguf_deleter>> outputs;
    outputs.emplace_back(gguf_init_empty());
    gguf_set_kv(outputs.back().get(), input.get());
    size_t current_bytes = 0;
    for (int64_t index = 0; index < tensor_count; ++index) {
        const char * name = gguf_get_tensor_name(input.get(), index);
        ggml_tensor * tensor = ggml_get_tensor(meta.get(), name);
        if (!tensor) {
            return 5;
        }
        const size_t padded = GGML_PAD(ggml_nbytes(tensor), GGUF_DEFAULT_ALIGNMENT);
        if (current_bytes > 0 && current_bytes + padded > split_max_bytes) {
            if (outputs.size() >= 256) {
                return 6;
            }
            outputs.emplace_back(gguf_init_empty());
            current_bytes = 0;
        }
        gguf_add_tensor(outputs.back().get(), tensor);
        current_bytes += padded;
    }

    const uint16_t split_count = static_cast<uint16_t>(outputs.size());
    for (uint16_t index = 0; index < split_count; ++index) {
        gguf_set_val_u16(outputs[index].get(), "split.no", index);
        gguf_set_val_u16(outputs[index].get(), "split.count", split_count);
        gguf_set_val_i32(outputs[index].get(), "split.tensors.count", static_cast<int32_t>(tensor_count));
    }

    std::vector<uint32_t> tensor_splits;
    std::vector<uint64_t> output_offsets(outputs.size(), 0);
    std::vector<uint32_t> split_first(outputs.size(), 0);
    std::vector<uint32_t> split_counts(outputs.size(), 0);
    std::vector<uint64_t> header_sizes(outputs.size(), 0);

    uint32_t tensor_index = 0;
    for (uint32_t split = 0; split < outputs.size(); ++split) {
        split_first[split] = tensor_index;
        split_counts[split] = static_cast<uint32_t>(gguf_get_n_tensors(outputs[split].get()));
        header_sizes[split] = gguf_get_meta_size(outputs[split].get());
        output_offsets[split] = header_sizes[split];
        for (uint32_t local = 0; local < split_counts[split]; ++local) {
            tensor_splits.push_back(split);
            ++tensor_index;
        }

        std::vector<uint8_t> header(header_sizes[split]);
        gguf_get_meta_data(outputs[split].get(), header.data());
        std::ofstream header_out(std::string(argv[2]) + std::to_string(split) + ".gguf", std::ios::binary);
        header_out.write(reinterpret_cast<const char *>(header.data()), header.size());
        if (!header_out) {
            return 7;
        }
    }

    std::vector<tensor_plan> tensors;
    tensors.reserve(tensor_count);
    const uint64_t data_offset = gguf_get_data_offset(input.get());
    for (uint32_t index = 0; index < static_cast<uint32_t>(tensor_count); ++index) {
        const char * name = gguf_get_tensor_name(input.get(), index);
        ggml_tensor * tensor = ggml_get_tensor(meta.get(), name);
        const uint64_t length = ggml_nbytes(tensor);
        const uint32_t split = tensor_splits[index];
        tensors.push_back({
            data_offset + gguf_get_tensor_offset(input.get(), index),
            length,
            split,
            output_offsets[split],
        });
        output_offsets[split] += GGML_PAD(length, GGUF_DEFAULT_ALIGNMENT);
    }

    std::ofstream plan(argv[3], std::ios::binary);
    plan.write("WAISPLIT", 8);
    write_scalar<uint32_t>(plan, 1);
    write_scalar<uint32_t>(plan, outputs.size());
    write_scalar<uint64_t>(plan, tensor_count);
    for (uint32_t split = 0; split < outputs.size(); ++split) {
        write_scalar<uint64_t>(plan, header_sizes[split]);
        write_scalar<uint64_t>(plan, output_offsets[split]);
        write_scalar<uint32_t>(plan, split_first[split]);
        write_scalar<uint32_t>(plan, split_counts[split]);
    }
    for (const tensor_plan & tensor : tensors) {
        write_scalar<uint64_t>(plan, tensor.input_offset);
        write_scalar<uint64_t>(plan, tensor.length);
        write_scalar<uint32_t>(plan, tensor.split);
        write_scalar<uint32_t>(plan, 0);
        write_scalar<uint64_t>(plan, tensor.output_offset);
    }
    return plan ? 0 : 8;
}
