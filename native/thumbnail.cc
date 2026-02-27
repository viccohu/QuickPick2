#include <napi.h>
#include <vector>
#include <string>
#include <algorithm>

#ifdef _WIN32
#include <windows.h>
#else
#include <sys/stat.h>
#endif

struct ThumbnailResult {
    std::string path;
    std::vector<uint8_t> data;
    int width;
    int height;
    bool success;
    std::string error;
};

class ThumbnailGenerator : public Napi::AsyncWorker {
public:
    ThumbnailGenerator(Napi::Env& env, 
                       const std::vector<std::string>& paths,
                       int maxWidth,
                       int maxHeight,
                       int quality)
        : Napi::AsyncWorker(env),
          paths_(paths),
          maxWidth_(maxWidth),
          maxHeight_(maxHeight),
          quality_(quality),
          deferred_(Napi::Promise::Deferred::New(env)) {}
    
    Napi::Promise GetPromise() { return deferred_.Promise(); }

protected:
    void Execute() {
        results_.reserve(paths_.size());
        
        for (size_t i = 0; i < paths_.size(); i++) {
            ThumbnailResult result;
            result.path = paths_[i];
            result.success = false;
            
            std::string ext = GetExtension(paths_[i]);
            std::transform(ext.begin(), ext.end(), ext.begin(), ::tolower);
            
            if (ext == ".jpg" || ext == ".jpeg") {
                result = GenerateJpegThumbnail(paths_[i]);
            } else if (ext == ".png") {
                result = GeneratePngThumbnail(paths_[i]);
            } else if (IsRawFile(ext)) {
                result.error = "RAW format requires libraw library";
            } else {
                result.error = "Unsupported format";
            }
            
            results_.push_back(result);
        }
    }
    
    void OnOK() {
        Napi::Env env = Env();
        Napi::Array results = Napi::Array::New(env, results_.size());
        
        for (size_t i = 0; i < results_.size(); i++) {
            Napi::Object obj = Napi::Object::New(env);
            obj.Set("path", Napi::String::New(env, results_[i].path));
            obj.Set("width", Napi::Number::New(env, results_[i].width));
            obj.Set("height", Napi::Number::New(env, results_[i].height));
            obj.Set("success", Napi::Boolean::New(env, results_[i].success));
            
            if (results_[i].success && !results_[i].data.empty()) {
                Napi::Buffer<uint8_t> buffer = Napi::Buffer<uint8_t>::Copy(
                    env, results_[i].data.data(), results_[i].data.size());
                obj.Set("data", buffer);
            }
            
            if (!results_[i].error.empty()) {
                obj.Set("error", Napi::String::New(env, results_[i].error));
            }
            
            results.Set(static_cast<uint32_t>(i), obj);
        }
        
        deferred_.Resolve(results);
    }
    
    void OnError(const Napi::Error& e) {
        deferred_.Reject(e.Value());
    }

private:
    std::vector<std::string> paths_;
    int maxWidth_;
    int maxHeight_;
    int quality_;
    Napi::Promise::Deferred deferred_;
    std::vector<ThumbnailResult> results_;
    
    std::string GetExtension(const std::string& path) {
        size_t pos = path.find_last_of('.');
        if (pos != std::string::npos) {
            return path.substr(pos);
        }
        return "";
    }
    
    bool IsRawFile(const std::string& ext) {
        static const std::vector<std::string> rawExts = {
            ".cr2", ".cr3", ".nef", ".arw", ".dng", ".raf", 
            ".orf", ".rw2", ".pef", ".srw", ".x3f", ".raw"
        };
        return std::find(rawExts.begin(), rawExts.end(), ext) != rawExts.end();
    }
    
    ThumbnailResult GenerateJpegThumbnail(const std::string& path) {
        ThumbnailResult result;
        result.path = path;
        result.success = false;
        
        FILE* file = fopen(path.c_str(), "rb");
        if (!file) {
            result.error = "Cannot open file";
            return result;
        }
        
        fseek(file, 0, SEEK_END);
        long fileSize = ftell(file);
        fseek(file, 0, SEEK_SET);
        
        std::vector<uint8_t> fileData(fileSize);
        fread(fileData.data(), 1, fileSize, file);
        fclose(file);
        
        result.data = std::move(fileData);
        result.success = true;
        result.width = maxWidth_;
        result.height = maxHeight_;
        
        return result;
    }
    
    ThumbnailResult GeneratePngThumbnail(const std::string& path) {
        return GenerateJpegThumbnail(path);
    }
};

Napi::Value GenerateThumbnails(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 1 || !info[0].IsArray()) {
        Napi::TypeError::New(env, "Expected array of paths").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    Napi::Array pathsArray = info[0].As<Napi::Array>();
    std::vector<std::string> paths;
    paths.reserve(pathsArray.Length());
    
    for (uint32_t i = 0; i < pathsArray.Length(); i++) {
        paths.push_back(pathsArray.Get(i).As<Napi::String>().Utf8Value());
    }
    
    int maxWidth = 120;
    int maxHeight = 80;
    int quality = 85;
    
    if (info.Length() > 1 && info[1].IsObject()) {
        Napi::Object options = info[1].As<Napi::Object>();
        if (options.Has("maxWidth")) maxWidth = options.Get("maxWidth").As<Napi::Number>().Int32Value();
        if (options.Has("maxHeight")) maxHeight = options.Get("maxHeight").As<Napi::Number>().Int32Value();
        if (options.Has("quality")) quality = options.Get("quality").As<Napi::Number>().Int32Value();
    }
    
    ThumbnailGenerator* worker = new ThumbnailGenerator(env, paths, maxWidth, maxHeight, quality);
    worker->Queue();
    return worker->GetPromise();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("generateThumbnails", Napi::Function::New(env, GenerateThumbnails));
    return exports;
}

NODE_API_MODULE(quickpick_native, Init)
