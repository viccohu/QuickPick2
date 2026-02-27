#include <napi.h>
#include <vector>
#include <string>
#include <fstream>
#include <algorithm>

struct ExifResult {
    std::string path;
    int rating;
    bool success;
    std::string error;
};

class ExifReader : public Napi::AsyncWorker {
public:
    ExifReader(Napi::Env& env, const std::vector<std::string>& paths)
        : Napi::AsyncWorker(env),
          paths_(paths),
          deferred_(Napi::Promise::Deferred::New(env)) {}
    
    Napi::Promise GetPromise() { return deferred_.Promise(); }

protected:
    void Execute() {
        results_.reserve(paths_.size());
        
        for (size_t i = 0; i < paths_.size(); i++) {
            ExifResult result;
            result.path = paths_[i];
            result.success = false;
            result.rating = 0;
            
            result.rating = ReadRating(paths_[i]);
            result.success = true;
            
            results_.push_back(result);
        }
    }
    
    void OnOK() {
        Napi::Env env = Env();
        Napi::Object results = Napi::Object::New(env);
        
        for (size_t i = 0; i < results_.size(); i++) {
            Napi::Object obj = Napi::Object::New(env);
            obj.Set("rating", Napi::Number::New(env, results_[i].rating));
            obj.Set("success", Napi::Boolean::New(env, results_[i].success));
            
            results.Set(results_[i].path, obj);
        }
        
        deferred_.Resolve(results);
    }
    
    void OnError(const Napi::Error& e) {
        deferred_.Reject(e.Value());
    }

private:
    std::vector<std::string> paths_;
    Napi::Promise::Deferred deferred_;
    std::vector<ExifResult> results_;
    
    int ReadRating(const std::string& path) {
        std::ifstream file(path, std::ios::binary);
        if (!file.is_open()) {
            return 0;
        }
        
        file.seekg(0, std::ios::end);
        std::streampos fileSize = file.tellg();
        file.seekg(0, std::ios::beg);
        
        if (fileSize < 4) return 0;
        
        uint8_t marker1, marker2;
        file.read(reinterpret_cast<char*>(&marker1), 1);
        file.read(reinterpret_cast<char*>(&marker2), 1);
        
        if (marker1 != 0xFF || marker2 != 0xD8) {
            return 0;
        }
        
        std::streampos minSize = 4;
        while (file.tellg() < fileSize - minSize) {
            uint8_t prefix;
            file.read(reinterpret_cast<char*>(&prefix), 1);
            
            if (prefix != 0xFF) continue;
            
            uint8_t marker;
            file.read(reinterpret_cast<char*>(&marker), 1);
            
            if (marker == 0xE1) {
                char app1Header[6];
                file.read(app1Header, 6);
                
                if (std::string(app1Header, 4) == "Exif") {
                    return ParseExifRating(file, fileSize);
                }
            } else if (marker == 0xDA || marker == 0xD9) {
                break;
            } else if (marker >= 0xE0 && marker <= 0xEF) {
                uint16_t length;
                file.read(reinterpret_cast<char*>(&length), 2);
                length = (length >> 8) | (length << 8);
                file.seekg(length - 2, std::ios::cur);
            }
        }
        
        return 0;
    }
    
    int ParseExifRating(std::ifstream& file, std::streampos fileSize) {
        char tiffHeader[8];
        file.read(tiffHeader, 8);
        
        bool littleEndian = (tiffHeader[0] == 0x49);
        
        auto readUint16 = [&littleEndian, &file]() -> uint16_t {
            uint8_t bytes[2];
            file.read(reinterpret_cast<char*>(bytes), 2);
            return littleEndian ? bytes[0] | (bytes[1] << 8) : (bytes[0] << 8) | bytes[1];
        };
        
        auto readUint32 = [&littleEndian, &file]() -> uint32_t {
            uint8_t bytes[4];
            file.read(reinterpret_cast<char*>(bytes), 4);
            return littleEndian 
                ? bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)
                : (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
        };
        
        uint32_t ifdOffset = readUint32();
        std::streampos currentPos = file.tellg();
        file.seekg(ifdOffset - 8, std::ios::cur);
        
        uint16_t numEntries = readUint16();
        
        for (uint16_t i = 0; i < numEntries; i++) {
            uint16_t tag = readUint16();
            uint16_t type = readUint16();
            uint32_t count = readUint32();
            
            char valueBytes[4];
            file.read(valueBytes, 4);
            
            if (tag == 0x4746) {
                uint16_t rating = littleEndian 
                    ? static_cast<uint8_t>(valueBytes[0]) | (static_cast<uint8_t>(valueBytes[1]) << 8)
                    : (static_cast<uint8_t>(valueBytes[0]) << 8) | static_cast<uint8_t>(valueBytes[1]);
                return static_cast<int>(rating);
            }
        }
        
        return 0;
    }
};

Napi::Value ReadExifRatings(const Napi::CallbackInfo& info) {
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
    
    ExifReader* worker = new ExifReader(env, paths);
    worker->Queue();
    return worker->GetPromise();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("readExifRatings", Napi::Function::New(env, ReadExifRatings));
    return exports;
}

NODE_API_MODULE(exif_reader, Init)
