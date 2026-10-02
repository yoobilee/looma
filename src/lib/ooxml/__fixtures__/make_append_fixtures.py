"""
신규 TC 행 추가 테스트용 XLSX fixture를 만든다(openpyxl 3.1). 실행: python make_append_fixtures.py
- append-base.xlsx: 행을 추가할 수 있는 단순 TC 시트(공유 문자열 · 열별 다른 스타일 · 행 높이 · 틀 고정 · 다른 시트의 수식)
- append-table.xlsx · append-autofilter.xlsx · append-merged.xlsx · append-cf.xlsx: 행 추가를 막아야 하는 구조
- append-dv.xlsx: 새 행까지 덮는 데이터 유효성(I2:I1000)이라 행을 추가해도 되는 구조
날짜 메타데이터는 고정해 다시 만들어도 내용이 같게 한다.
"""

import datetime
import os

from openpyxl import Workbook
from openpyxl.formatting.rule import CellIsRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.worksheet.table import Table

HERE = os.path.dirname(os.path.abspath(__file__))
FIXED = datetime.datetime(2026, 1, 1, 9, 0, 0)

HEADERS = ['TC ID', '테스트 관점', '대분류', '중분류', '테스트 항목', 'Pre-condition', 'Test Step', 'Expected Result', '결과', '비고']
ROWS = [
    ['MEM-001', '정상 흐름', '회원가입', '이메일', '이메일 가입', '앱 설치', '1. 앱을 연다.\n2. 이메일을 입력한다.', '가입 완료', 'P', '고객 메모'],
    ['MEM-002', '예외', '회원가입', '약관', '약관 미동의 & <필수>', '', '1. 약관을 연다.', '다음 단계로 가지 않음', 'F', None],
    ['MEM-003', '경계값', '회원가입', '비밀번호', '비밀번호 8자', '가입 화면', '1. 8자를 입력한다.', '가입 진행', None, None],
]

thin = Side(style='thin', color='FF9AA4B2')
border = Border(left=thin, right=thin, top=thin, bottom=thin)
header_style = dict(font=Font(bold=True, color='FFFFFFFF'), fill=PatternFill('solid', fgColor='FF4D8EF7'), border=border, alignment=Alignment(horizontal='center', vertical='center'))
text_style = dict(border=border, alignment=Alignment(wrap_text=True, vertical='top'))
result_style = dict(border=border, alignment=Alignment(horizontal='center', vertical='top'), fill=PatternFill('solid', fgColor='FFFFF4E5'))
memo_style = dict(border=border, font=Font(italic=True, color='FF6B7280'), alignment=Alignment(wrap_text=True, vertical='top'))


def apply(cell, style):
    for key, value in style.items():
        setattr(cell, key, value)


def base_workbook():
    wb = Workbook()
    wb.properties.created = FIXED
    wb.properties.modified = FIXED
    cover = wb.active
    cover.title = '표지'
    cover['A1'] = '회원가입 TC'
    cover['A2'] = '=COUNTA(TC!A2:A100)'
    ws = wb.create_sheet('TC')
    for index, header in enumerate(HEADERS, start=1):
        apply(ws.cell(row=1, column=index, value=header), header_style)
    for row_index, values in enumerate(ROWS, start=2):
        for index, value in enumerate(values, start=1):
            cell = ws.cell(row=row_index, column=index, value=value)
            apply(cell, result_style if index == 9 else memo_style if index == 10 else text_style)
    for letter, width in zip('ABCDEFGHIJ', [12, 12, 12, 12, 28, 18, 36, 24, 8, 18]):
        ws.column_dimensions[letter].width = width
    ws.row_dimensions[1].height = 24
    ws.row_dimensions[4].height = 36
    ws.freeze_panes = 'A2'
    return wb, ws


def save(wb, name):
    wb.save(os.path.join(HERE, name))


wb, ws = base_workbook()
save(wb, 'append-base.xlsx')

wb, ws = base_workbook()
ws.add_table(Table(displayName='TcTable', ref='A1:J4'))
save(wb, 'append-table.xlsx')

wb, ws = base_workbook()
ws.auto_filter.ref = 'A1:J4'
save(wb, 'append-autofilter.xlsx')

wb, ws = base_workbook()
ws.merge_cells('J3:J4')
save(wb, 'append-merged.xlsx')

wb, ws = base_workbook()
ws.conditional_formatting.add('I2:I4', CellIsRule(operator='equal', formula=['"F"'], fill=PatternFill('solid', fgColor='FFF28B7B')))
save(wb, 'append-cf.xlsx')

wb, ws = base_workbook()
validation = DataValidation(type='list', formula1='"P,F,N/A"', allow_blank=True)
validation.add('I2:I1000')
ws.add_data_validation(validation)
save(wb, 'append-dv.xlsx')
