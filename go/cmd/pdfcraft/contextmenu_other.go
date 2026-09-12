//go:build !windows

package main

import "fmt"

func installContextMenu() error {
	return fmt.Errorf("tính năng này chỉ hỗ trợ hệ điều hành Windows")
}

func uninstallContextMenu() error {
	return fmt.Errorf("tính năng này chỉ hỗ trợ hệ điều hành Windows")
}

func isContextMenuInstalled() bool {
	return false
}

func runRegisterMenu() {
	fmt.Println("Chức năng đăng ký Menu chuột phải Windows chỉ khả dụng trên hệ điều hành Windows.")
}

func runUnregisterMenu() {
	fmt.Println("Chức năng gỡ bỏ Menu chuột phải Windows chỉ khả dụng trên hệ điều hành Windows.")
}
