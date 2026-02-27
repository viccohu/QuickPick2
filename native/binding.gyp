{
  "targets": [
    {
      "target_name": "quickpick_native",
      "sources": [
        "quickpick_native.cc"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "conditions": [
        ["OS=='win'", {
          "defines": [
            "NAPI_DISABLE_CPP_EXCEPTIONS",
            "WIN32_LEAN_AND_MEAN"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 0,
              "AdditionalOptions": ["/std:c++17"]
            }
          }
        }],
        ["OS=='mac'", {
          "cflags_cc": ["-std=c++17", "-fvisibility=hidden"]
        }],
        ["OS=='linux'", {
          "cflags_cc": ["-std=c++17", "-fvisibility=hidden"]
        }]
      ]
    }
  ]
}
