#!/usr/bin/env python3
import struct
import sys
import os
import json
import base64

def extract_pkg_metadata(pkg_path):
    """Extract metadata from PKG file and return as JSON"""
    try:
        print(f"DEBUG: Starting extraction for {pkg_path}", file=sys.stderr)
        
        # Extract SFO directly from PKG without external tools
        sfo_data = extract_sfo_direct_from_pkg(pkg_path)
        
        if not sfo_data:
            return {"error": "Failed to extract SFO from PKG"}
        
        # Extract icon if available
        icon_data = extract_icon_from_pkg(pkg_path)
        icon_base64 = base64.b64encode(icon_data).decode('utf-8') if icon_data else None
        
        # Map to your C structure format
        metadata = {
            'user_id': 0,
            'entitlement_type': 0, 
            'id': sfo_data.get('CONTENT_ID', ''),
            'content_url': f"http://gs2.ww.prod.dl.playstation.net/gs2/ppk/go/{sfo_data.get('CONTENT_ID', '')}",
            'content_ex_url': '',
            'content_name': sfo_data.get('TITLE', ''),
            'icon_path': '/icon0.png',
            'icon_data': icon_base64,  # Base64 encoded icon for display
            'sku_id': sfo_data.get('TITLE_ID', ''),
            'option': 0,
            'playgo_scenario_id': '',
            'release_date': sfo_data.get('RELEASE_DATE', ''),
            'package_type': sfo_data.get('CATEGORY', ''),
            'package_sub_type': sfo_data.get('ATTRIBUTE', ''),
            'package_size': os.path.getsize(pkg_path) if os.path.exists(pkg_path) else 0
        }
        
        print(f"DEBUG: Successfully extracted metadata", file=sys.stderr)
        return metadata
        
    except Exception as e:
        error_msg = f"Extraction failed: {str(e)}"
        print(f"DEBUG: {error_msg}", file=sys.stderr)
        return {"error": error_msg}

def extract_sfo_direct_from_pkg(pkg_path):
    """Extract SFO data directly from PKG file by finding and parsing the SFO section"""
    try:
        print(f"DEBUG: Extracting SFO directly from PKG", file=sys.stderr)
        
        with open(pkg_path, 'rb') as f:
            data = f.read()
        
        print(f"DEBUG: PKG file size: {len(data)} bytes", file=sys.stderr)
        
        # PKG structure: Look for SFO section
        # SFO magic is 0x46535000 (little endian: 00 50 53 46)
        sfo_magic = b'\x00PSF'
        
        # Search for SFO magic at common offsets
        search_offsets = [0x800, 0x1000, 0x2000, 0x4000, 0x8000]
        sfo_offset = -1
        
        for offset in search_offsets:
            if offset + 4 < len(data) and data[offset:offset+4] == sfo_magic:
                sfo_offset = offset
                print(f"DEBUG: Found SFO at offset 0x{offset:X}", file=sys.stderr)
                break
        
        # If not found at common offsets, search the whole file
        if sfo_offset == -1:
            print(f"DEBUG: Searching entire file for SFO magic...", file=sys.stderr)
            for offset in range(0, len(data) - 4, 4):
                if data[offset:offset+4] == sfo_magic:
                    sfo_offset = offset
                    print(f"DEBUG: Found SFO at offset 0x{offset:X}", file=sys.stderr)
                    break
        
        if sfo_offset == -1:
            print(f"DEBUG: SFO magic not found in PKG", file=sys.stderr)
            return None
        
        # Extract SFO data from the found offset
        sfo_data = data[sfo_offset:sfo_offset + 0x4000]  # Read reasonable chunk
        return parse_sfo_data(sfo_data)
        
    except Exception as e:
        print(f"DEBUG: Error extracting SFO directly: {e}", file=sys.stderr)
        return None

def parse_sfo_data(sfo_data):
    """Parse SFO data and extract metadata"""
    try:
        print(f"DEBUG: Parsing SFO data ({len(sfo_data)} bytes)", file=sys.stderr)
        
        # Parse SFO header
        if len(sfo_data) < 20:
            print(f"DEBUG: SFO data too small", file=sys.stderr)
            return None
            
        magic, version, key_table_start, data_table_start, table_count = struct.unpack('<IIIII', sfo_data[:20])
        
        print(f"DEBUG: SFO magic: 0x{magic:08X}, entries: {table_count}", file=sys.stderr)
        print(f"DEBUG: Key table start: 0x{key_table_start:X}, Data table start: 0x{data_table_start:X}", file=sys.stderr)
        
        if magic != 0x46535000:
            print(f"DEBUG: Invalid SFO magic", file=sys.stderr)
            return None
        
        # Parse index entries
        entries = []
        offset = 20
        for i in range(table_count):
            if offset + 16 > len(sfo_data):
                print(f"DEBUG: Unexpected EOF in index table", file=sys.stderr)
                break
            key_offset, data_fmt, data_len, data_max_len, data_offset = struct.unpack('<HHIII', sfo_data[offset:offset+16])
            entries.append((key_offset, data_fmt, data_len, data_offset))
            offset += 16
        
        print(f"DEBUG: Parsed {len(entries)} index entries", file=sys.stderr)
        
        # Read key names
        key_names = []
        for i, (key_offset, data_fmt, data_len, data_offset) in enumerate(entries):
            key_name = ""
            pos = key_table_start + key_offset
            while pos < len(sfo_data) and sfo_data[pos] != 0:
                key_name += chr(sfo_data[pos])
                pos += 1
            key_names.append(key_name)
            print(f"DEBUG: Entry {i}: key_offset=0x{key_offset:X}, key_name='{key_name}', data_fmt=0x{data_fmt:04X}, data_len={data_len}, data_offset=0x{data_offset:X}", file=sys.stderr)
        
        print(f"DEBUG: Found keys: {key_names}", file=sys.stderr)
        
        # Read values with PROPER UTF-16 handling
        sfo_result = {}
        for key_name, (_, data_fmt, data_len, data_offset) in zip(key_names, entries):
            data_pos = data_table_start + data_offset
            if data_pos >= len(sfo_data):
                print(f"DEBUG: Data position out of range for {key_name}", file=sys.stderr)
                continue
            
            raw_data = sfo_data[data_pos:data_pos + min(data_len, len(sfo_data) - data_pos)]
            
            if data_fmt == 0x0404:  # UTF-8
                value = raw_data.decode('utf-8', errors='ignore').rstrip('\x00')
            elif data_fmt == 0x0204:  # UTF-16 - FIXED: Take ALL bytes from even positions
                # CORRECT UTF-16 LE extraction: Take EVERY byte at even positions
                decoded_chars = []
                for i in range(0, len(raw_data), 2):
                    if i < len(raw_data):
                        byte_val = raw_data[i]
                        decoded_chars.append(chr(byte_val))
                value = ''.join(decoded_chars).rstrip('\x00')
            elif data_fmt == 0x0400:  # Integer
                value = struct.unpack('<I', raw_data[:4])[0] if len(raw_data) >= 4 else 0
            else:
                # Try to extract ASCII characters
                try:
                    value = raw_data.decode('ascii', errors='ignore').rstrip('\x00')
                except:
                    value = f"0x{raw_data.hex()}"
            
            sfo_result[key_name] = value
            print(f"DEBUG: {key_name} = '{value}' (format: 0x{data_fmt:04X}, raw_hex: {raw_data.hex()})", file=sys.stderr)
        
        print(f"DEBUG: Final SFO data: {sfo_result}", file=sys.stderr)
        return sfo_result
        
    except Exception as e:
        print(f"DEBUG: Error parsing SFO: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        return None

def extract_icon_from_pkg(pkg_path):
    """Extract icon0.png from PKG file"""
    try:
        print(f"DEBUG: Extracting icon from PKG", file=sys.stderr)
        
        with open(pkg_path, 'rb') as f:
            data = f.read()
        
        # Look for PNG signature in common icon offsets
        png_signature = b'\x89PNG\r\n\x1a\n'
        
        # Common icon offsets in PKG files (based on typical PKG structure)
        icon_offsets = [
            0x55A0,    # Common icon offset 1
            0x10000,   # Common icon offset 2  
            0x20000,   # Common icon offset 3
            0x40000,   # Common icon offset 4
            0x80000,   # Common icon offset 5
            0x100000,  # Common icon offset 6
        ]
        
        for offset in icon_offsets:
            if offset + 8 < len(data) and data[offset:offset+8] == png_signature:
                print(f"DEBUG: Found PNG at offset 0x{offset:X}", file=sys.stderr)
                # Extract PNG data (PNG files end with IEND chunk)
                png_data = extract_png_data(data, offset)
                if png_data:
                    print(f"DEBUG: Successfully extracted icon ({len(png_data)} bytes)", file=sys.stderr)
                    return png_data
        
        # If not found at common offsets, search the entire file
        print(f"DEBUG: Searching entire file for PNG signature...", file=sys.stderr)
        for offset in range(0, len(data) - 8, 4):
            if data[offset:offset+8] == png_signature:
                print(f"DEBUG: Found PNG at offset 0x{offset:X}", file=sys.stderr)
                png_data = extract_png_data(data, offset)
                if png_data:
                    print(f"DEBUG: Successfully extracted icon ({len(png_data)} bytes)", file=sys.stderr)
                    return png_data
        
        print(f"DEBUG: No icon found in PKG", file=sys.stderr)
        return None
        
    except Exception as e:
        print(f"DEBUG: Error extracting icon: {e}", file=sys.stderr)
        return None

def extract_png_data(data, offset):
    """Extract complete PNG file data"""
    try:
        # PNG ends with IEND chunk
        iend_marker = b'IEND\xae\x42\x60\x82'
        iend_pos = data.find(iend_marker, offset)
        
        if iend_pos != -1:
            png_end = iend_pos + 8  # IEND chunk is 8 bytes
            png_data = data[offset:png_end]
            
            # Verify it's a valid PNG by checking the header
            if png_data.startswith(b'\x89PNG\r\n\x1a\n'):
                return png_data
        
        return None
    except Exception as e:
        print(f"DEBUG: Error extracting PNG data: {e}", file=sys.stderr)
        return None

if __name__ == "__main__":
    try:
        if len(sys.argv) > 1:
            pkg_path = sys.argv[1]
            print(f"DEBUG: Processing PKG: {pkg_path}", file=sys.stderr)
            
            if not os.path.exists(pkg_path):
                result = {"error": f"PKG file not found: {pkg_path}"}
                print(f"DEBUG: {result['error']}", file=sys.stderr)
            else:
                result = extract_pkg_metadata(pkg_path)
        else:
            result = {"error": "No PKG file specified"}
            print(f"DEBUG: {result['error']}", file=sys.stderr)
        
        # Always output valid JSON
        print(json.dumps(result, indent=2))
        
    except Exception as e:
        # Final fallback - always return valid JSON
        error_result = {"error": f"Unexpected error: {str(e)}"}
        print(f"DEBUG: Final fallback error: {e}", file=sys.stderr)
        print(json.dumps(error_result, indent=2))