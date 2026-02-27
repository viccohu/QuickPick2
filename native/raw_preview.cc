#include <napi.h>
#include <vector>
#include <string>
#include <algorithm>
#include <cstring>

#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#else
#include <sys/stat.h>
#endif

struct RawPreviewResult {
    std::vector<uint8_t> data;
    int width;
    int height;
    bool success;
    std::string error;
};

static bool IsRawExtension(const std::string& ext) {
    static const std::vector<std::string> rawExts = {
        ".cr2", ".cr3", ".nef", ".arw", ".dng", ".raf",
        ".orf", ".rw2", ".pef", ".srw", ".x3f", ".raw"
    };
    std::string lowerExt = ext;
    std::transform(lowerExt.begin(), lowerExt.end(), lowerExt.begin(), ::tolower);
    return std::find(rawExts.begin(), rawExts.end(), lowerExt) != rawExts.end();
}

static std::string GetExtension(const std::string& path) {
    size_t pos = path.find_last_of('.');
    if (pos != std::string::npos) {
        return path.substr(pos);
    }
    return "";
}

#ifdef _WIN32
static std::wstring Utf8ToWide(const std::string& str) {
    if (str.empty()) return std::wstring();
    int size = MultiByteToWideChar(CP_UTF8, 0, str.c_str(), -1, nullptr, 0);
    std::wstring result(size - 1, 0);
    MultiByteToWideChar(CP_UTF8, 0, str.c_str(), -1, &result[0], size);
    return result;
}
#endif

static RawPreviewResult ExtractEmbeddedJpeg(const std::string& filePath) {
    RawPreviewResult result;
    result.success = false;
    result.width = 0;
    result.height = 0;
    
    FILE* file = nullptr;
#ifdef _WIN32
    std::wstring widePath = Utf8ToWide(filePath);
    file = _wfopen(widePath.c_str(), L"rb");
#else
    file = fopen(filePath.c_str(), "rb");
#endif
    if (!file) {
        result.error = "Cannot open file";
        return result;
    }
    
    fseek(file, 0, SEEK_END);
    long fileSize = ftell(file);
    fseek(file, 0, SEEK_SET);
    
    if (fileSize < 4) {
        fclose(file);
        result.error = "File too small";
        return result;
    }
    
    std::vector<uint8_t> buffer(fileSize);
    size_t bytesRead = fread(buffer.data(), 1, fileSize, file);
    fclose(file);
    
    if (bytesRead != (size_t)fileSize) {
        result.error = "Failed to read file";
        return result;
    }
    
    std::vector<std::pair<size_t, size_t>> jpegList;
    
    for (size_t i = 0; i < fileSize - 1; i++) {
        if (buffer[i] == 0xFF && buffer[i + 1] == 0xD8) {
            size_t jpegEnd = i + 2;
            while (jpegEnd < (size_t)fileSize - 1) {
                if (buffer[jpegEnd] == 0xFF && buffer[jpegEnd + 1] == 0xD9) {
                    jpegEnd += 2;
                    size_t jpegSize = jpegEnd - i;
                    jpegList.push_back({i, jpegSize});
                    break;
                }
                jpegEnd++;
            }
        }
    }
    
    size_t jpegStart = 0;
    size_t largestJpegSize = 0;
    
    for (const auto& jpeg : jpegList) {
        if (jpeg.second > largestJpegSize) {
            largestJpegSize = jpeg.second;
            jpegStart = jpeg.first;
        }
    }
    
    if (largestJpegSize > 0) {
        result.data.assign(buffer.begin() + jpegStart, 
                          buffer.begin() + jpegStart + largestJpegSize);
        result.success = true;
        
        for (size_t i = jpegStart; i < jpegStart + largestJpegSize - 8; i++) {
            if (buffer[i] == 0xFF && (buffer[i+1] & 0xF0) == 0xC0 && buffer[i+1] != 0xC4) {
                if (i + 8 < jpegStart + largestJpegSize) {
                    result.height = (buffer[i+5] << 8) | buffer[i+6];
                    result.width = (buffer[i+7] << 8) | buffer[i+8];
                    break;
                }
            }
        }
    } else {
        result.error = "No embedded JPEG found";
    }
    
    return result;
}

class RawPreviewWorker : public Napi::AsyncWorker {
public:
    RawPreviewWorker(Napi::Env& env, const std::string& filePath)
        : Napi::AsyncWorker(env),
          filePath_(filePath),
          deferred_(Napi::Promise::Deferred::New(env)) {}
    
    Napi::Promise GetPromise() { return deferred_.Promise(); }

protected:
    void Execute() {
        std::string ext = GetExtension(filePath_);
        
        if (!IsRawExtension(ext)) {
            result_.success = false;
            result_.error = "Not a RAW file";
            return;
        }
        
        result_ = ExtractEmbeddedJpeg(filePath_);
    }
    
    void OnOK() {
        Napi::Env env = Env();
        Napi::Object obj = Napi::Object::New(env);
        
        obj.Set("success", Napi::Boolean::New(env, result_.success));
        obj.Set("width", Napi::Number::New(env, result_.width));
        obj.Set("height", Napi::Number::New(env, result_.height));
        
        if (result_.success && !result_.data.empty()) {
            Napi::Buffer<uint8_t> buffer = Napi::Buffer<uint8_t>::Copy(
                env, result_.data.data(), result_.data.size());
            obj.Set("data", buffer);
        }
        
        if (!result_.error.empty()) {
            obj.Set("error", Napi::String::New(env, result_.error));
        }
        
        deferred_.Resolve(obj);
    }
    
    void OnError(const Napi::Error& e) {
        deferred_.Reject(e.Value());
    }

private:
    std::string filePath_;
    RawPreviewResult result_;
    Napi::Promise::Deferred deferred_;
};

Napi::Value GetRawPreview(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected file path string").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    std::string filePath = info[0].As<Napi::String>().Utf8Value();
    
    RawPreviewWorker* worker = new RawPreviewWorker(env, filePath);
    worker->Queue();
    return worker->GetPromise();
}

Napi::Value GetRawPreviewSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected file path string").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    std::string filePath = info[0].As<Napi::String>().Utf8Value();
    
    std::string ext = GetExtension(filePath);
    if (!IsRawExtension(ext)) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("success", Napi::Boolean::New(env, false));
        obj.Set("error", Napi::String::New(env, "Not a RAW file"));
        return obj;
    }
    
    RawPreviewResult result = ExtractEmbeddedJpeg(filePath);
    
    Napi::Object obj = Napi::Object::New(env);
    obj.Set("success", Napi::Boolean::New(env, result.success));
    obj.Set("width", Napi::Number::New(env, result.width));
    obj.Set("height", Napi::Number::New(env, result.height));
    
    if (result.success && !result.data.empty()) {
        Napi::Buffer<uint8_t> buffer = Napi::Buffer<uint8_t>::Copy(
            env, result.data.data(), result.data.size());
        obj.Set("data", buffer);
    }
    
    if (!result.error.empty()) {
        obj.Set("error", Napi::String::New(env, result.error));
    }
    
    return obj;
}
