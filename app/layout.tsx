import type { Metadata, Viewport } from "next";
import "./globals.css";
export const metadata: Metadata = {title:"观微 · SmartVerifier | 来料外观对比",description:"上传正品参考图，逐颗对比来料丝印、形状与表面细节。手机与桌面交互原型。",icons:{icon:"/favicon.svg",shortcut:"/favicon.svg"}};
export const viewport: Viewport = {width:"device-width",initialScale:1,viewportFit:"cover",themeColor:"#f7faf8"};
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>){return <html lang="zh-CN"><body>{children}</body></html>}
