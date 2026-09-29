cmake_minimum_required(VERSION 3.15)
project(Supertonic_CPP)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(SUPERTONIC_ORT_ROOT "" CACHE PATH
    "Pinned operator-owned ONNX Runtime prefix; leave empty to use the system resolver")

if(SUPERTONIC_ORT_ROOT)
    list(PREPEND CMAKE_PREFIX_PATH "${SUPERTONIC_ORT_ROOT}")
endif()

# Enable aggressive optimization
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

# Add optimization flags
set(CMAKE_CXX_FLAGS_RELEASE "${CMAKE_CXX_FLAGS_RELEASE} -O3 -DNDEBUG -ffast-math")
set(CMAKE_C_FLAGS_RELEASE "${CMAKE_C_FLAGS_RELEASE} -O3 -DNDEBUG -ffast-math")

# Find required packages
find_package(PkgConfig REQUIRED)
find_package(OpenMP)

# ONNX Runtime - Try multiple methods
# Method 1: Try to find via CMake config
find_package(onnxruntime QUIET CONFIG)

if(NOT onnxruntime_FOUND)
    # Method 2: Try pkg-config
    pkg_check_modules(ONNXRUNTIME QUIET libonnxruntime)
    
    if(ONNXRUNTIME_FOUND)
        set(ONNXRUNTIME_INCLUDE_DIR ${ONNXRUNTIME_INCLUDE_DIRS})
        # LINK_LIBRARIES holds absolute paths; LIBRARIES holds bare names (-l) that
        # the SUPERTONIC_ORT_ROOT provenance check cannot resolve.
        set(ONNXRUNTIME_LIB ${ONNXRUNTIME_LINK_LIBRARIES})
    else()
        # Method 3: Manual search in common locations
        find_path(ONNXRUNTIME_INCLUDE_DIR 
            NAMES onnxruntime_cxx_api.h
            PATHS
                /usr/local/include
                /opt/homebrew/include
                /usr/include
                ${CMAKE_PREFIX_PATH}/include
            PATH_SUFFIXES onnxruntime
        )
        
        find_library(ONNXRUNTIME_LIB
            NAMES onnxruntime libonnxruntime
            PATHS
                /usr/local/lib
                /opt/homebrew/lib
                /usr/lib
                ${CMAKE_PREFIX_PATH}/lib
        )
    endif()
    
    if(NOT ONNXRUNTIME_INCLUDE_DIR OR NOT ONNXRUNTIME_LIB)
        message(FATAL_ERROR "ONNX Runtime not found. Please install it:\n"
                            "  macOS: brew install onnxruntime\n"
                            "  Ubuntu: See README.md for installation instructions")
    endif()
    
    message(STATUS "Found ONNX Runtime:")
    message(STATUS "  Include: ${ONNXRUNTIME_INCLUDE_DIR}")
    message(STATUS "  Library: ${ONNXRUNTIME_LIB}")
else()
    get_target_property(ONNXRUNTIME_INCLUDE_DIR onnxruntime::onnxruntime
        INTERFACE_INCLUDE_DIRECTORIES)
    get_target_property(ONNXRUNTIME_LIB onnxruntime::onnxruntime
        IMPORTED_LOCATION)
endif()

find_file(ONNXRUNTIME_C_API_HEADER
    NAMES onnxruntime_c_api.h
    HINTS ${ONNXRUNTIME_INCLUDE_DIR}
    PATH_SUFFIXES onnxruntime
)

if(NOT ONNXRUNTIME_C_API_HEADER)
    message(FATAL_ERROR
        "ONNX Runtime C API header not found next to the resolved library. "
        "Set SUPERTONIC_ORT_ROOT to one operator-owned ONNX Runtime prefix.")
endif()

if(SUPERTONIC_ORT_ROOT)
    get_filename_component(_ort_root "${SUPERTONIC_ORT_ROOT}" REALPATH)

    function(_supertonic_check_ort_path label path)
        if(NOT IS_ABSOLUTE "${path}" OR NOT EXISTS "${path}")
            message(FATAL_ERROR "ONNX Runtime provenance: ${label} must be an existing absolute path: ${path}")
        endif()
        get_filename_component(_real "${path}" REALPATH)
        file(RELATIVE_PATH _relative "${_ort_root}" "${_real}")
        if(IS_ABSOLUTE "${_relative}" OR _relative MATCHES "^\\.\\.(/|$)")
            message(FATAL_ERROR
                "ONNX Runtime provenance: ${label} resolves outside SUPERTONIC_ORT_ROOT "
                "${_ort_root}: ${path} -> ${_real}")
        endif()
    endfunction()

    _supertonic_check_ort_path("C API header" "${ONNXRUNTIME_C_API_HEADER}")
    foreach(_include IN LISTS ONNXRUNTIME_INCLUDE_DIR)
        _supertonic_check_ort_path("include directory" "${_include}")
        foreach(_header onnxruntime_c_api.h onnxruntime_cxx_api.h)
            foreach(_suffix "" "/onnxruntime")
                if(EXISTS "${_include}${_suffix}/${_header}")
                    _supertonic_check_ort_path("header" "${_include}${_suffix}/${_header}")
                endif()
            endforeach()
        endforeach()
    endforeach()

    if(onnxruntime_FOUND)
        # Check all configurations: mappings and multi-config generators can select any of them.
        get_target_property(_ort_configs onnxruntime::onnxruntime IMPORTED_CONFIGURATIONS)
        list(APPEND _ort_configs ${CMAKE_CONFIGURATION_TYPES} "${CMAKE_BUILD_TYPE}")
        set(_ort_properties IMPORTED_LOCATION IMPORTED_IMPLIB)
        foreach(_config IN LISTS _ort_configs)
            string(TOUPPER "${_config}" _config)
            list(APPEND _ort_properties "IMPORTED_LOCATION_${_config}" "IMPORTED_IMPLIB_${_config}")
            get_target_property(_mapped onnxruntime::onnxruntime "MAP_IMPORTED_CONFIG_${_config}")
            foreach(_mapping IN LISTS _mapped)
                string(TOUPPER "${_mapping}" _mapping)
                list(APPEND _ort_properties "IMPORTED_LOCATION_${_mapping}" "IMPORTED_IMPLIB_${_mapping}")
            endforeach()
        endforeach()
        list(REMOVE_DUPLICATES _ort_properties)
        foreach(_property IN LISTS _ort_properties)
            get_target_property(_location onnxruntime::onnxruntime "${_property}")
            if(_location)
                _supertonic_check_ort_path("${_property}" "${_location}")
            endif()
        endforeach()
        get_target_property(ONNXRUNTIME_LIB onnxruntime::onnxruntime "LOCATION_${CMAKE_BUILD_TYPE}")
    endif()
    foreach(_binary IN LISTS ONNXRUNTIME_LIB)
        _supertonic_check_ort_path("binary" "${_binary}")
    endforeach()
endif()

file(STRINGS "${ONNXRUNTIME_C_API_HEADER}" ONNXRUNTIME_C_API_VERSION_LINE
    REGEX "^#define[ \t]+ORT_API_VERSION[ \t]+[0-9]+")
string(REGEX MATCH "[0-9]+$" ONNXRUNTIME_C_API_VERSION
    "${ONNXRUNTIME_C_API_VERSION_LINE}")

if(NOT ONNXRUNTIME_C_API_VERSION)
    message(FATAL_ERROR
        "Unable to determine ORT_API_VERSION from ${ONNXRUNTIME_C_API_HEADER}")
endif()

message(STATUS "Resolved ONNX Runtime C API version: ${ONNXRUNTIME_C_API_VERSION}")
message(STATUS "Resolved ONNX Runtime C API header: ${ONNXRUNTIME_C_API_HEADER}")
message(STATUS "Resolved ONNX Runtime binary: ${ONNXRUNTIME_LIB}")

# nlohmann/json
find_package(nlohmann_json REQUIRED)

# Include directories
if(NOT onnxruntime_FOUND)
    include_directories(${ONNXRUNTIME_INCLUDE_DIR})
endif()

# Helper library
add_library(tts_helper STATIC
    helper.cpp
    helper.h
)

if(onnxruntime_FOUND)
    target_link_libraries(tts_helper
        onnxruntime::onnxruntime
        nlohmann_json::nlohmann_json
    )
else()
    target_include_directories(tts_helper PUBLIC ${ONNXRUNTIME_INCLUDE_DIR})
    target_link_libraries(tts_helper
        ${ONNXRUNTIME_LIB}
        nlohmann_json::nlohmann_json
    )
endif()

# Enable OpenMP if available
if(OpenMP_CXX_FOUND)
    target_link_libraries(tts_helper OpenMP::OpenMP_CXX)
    message(STATUS "OpenMP enabled for parallel processing")
else()
    message(WARNING "OpenMP not found - parallel processing will be disabled")
endif()

# Example executable
add_executable(example_onnx
    example_onnx.cpp
)

if(onnxruntime_FOUND)
    target_link_libraries(example_onnx
        tts_helper
        onnxruntime::onnxruntime
        nlohmann_json::nlohmann_json
    )
else()
    target_link_libraries(example_onnx
        tts_helper
        ${ONNXRUNTIME_LIB}
        nlohmann_json::nlohmann_json
    )
endif()

# Installation
install(TARGETS example_onnx DESTINATION bin)
install(TARGETS tts_helper DESTINATION lib)
install(FILES helper.h DESTINATION include)
