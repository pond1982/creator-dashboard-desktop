// Secrets travel through pipes. Only the operation and item name are arguments.
#import <Foundation/Foundation.h>
#import <Security/Security.h>

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 3) return 64;
        NSString *operation = [NSString stringWithUTF8String:argv[1]];
        NSString *account = [NSString stringWithUTF8String:argv[2]];
        NSDictionary *item = @{
            (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService: @"local.creator-dashboard",
            (__bridge id)kSecAttrAccount: account
        };
        OSStatus status;
        if ([operation isEqualToString:@"set"]) {
            NSData *data = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
            if (!data.length || data.length > 32768) return 65;
            NSDictionary *change = @{(__bridge id)kSecValueData: data};
            status = SecItemUpdate((__bridge CFDictionaryRef)item, (__bridge CFDictionaryRef)change);
            if (status == errSecItemNotFound) {
                NSMutableDictionary *entry = [item mutableCopy];
                [entry addEntriesFromDictionary:change];
                status = SecItemAdd((__bridge CFDictionaryRef)entry, NULL);
            }
        } else if ([operation isEqualToString:@"get"]) {
            NSMutableDictionary *query = [item mutableCopy];
            query[(__bridge id)kSecReturnData] = @YES;
            CFTypeRef result = NULL;
            status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
            if (status == errSecSuccess) {
                NSData *data = CFBridgingRelease(result);
                [[NSFileHandle fileHandleWithStandardOutput] writeData:data];
            }
        } else if ([operation isEqualToString:@"delete"]) {
            status = SecItemDelete((__bridge CFDictionaryRef)item);
        } else {
            return 64;
        }
        if (status == errSecItemNotFound) return 44;
        if (status != errSecSuccess) {
            fprintf(stderr, "Keychain operation failed (%d).\n", (int)status);
            return 1;
        }
        return 0;
    }
}
