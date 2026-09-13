# ClipClap: supplemental episode recall — production release

## Данные

Исследован snapshot реальной работы 1–12 сентября 2026: 72 задания, 52 внешних аккаунта, 58 идентичностей исходников, 213 сохранённых строк клипов и 70 транскриптов. Синтетические, административные и распознаваемые test/example аккаунты исключены. Анализ сопоставлял исходные транскрипты и доступные видео, готовые клиентские клипы, 19 snapshot клиентского feedback, model requests/responses и внутреннюю telemetry.

Парная quality-выборка содержит 31 уникальный development source, 18 заранее отделённых holdout source и три новых source от аккаунтов, отсутствующих в первых двух наборах: всего 52 уникальных source. Для проверки стохастичности дополнительно заново проанализированы десять репрезентативных source без кэша старой версии, после чего новая версия повторила те же запросы и выполняла live только изменившиеся ветки.

Медиа доступны не для всех строк snapshot: сохранены оригиналы 23/33 development-прогонов, 12/18 первоначального holdout и всех трёх новых source; скачаны 12 готовых клиентских клипов. Просмотр использовал транскрипты, кадры, contact sheets и production renders, без заявления о полном просмотре всех источников со звуком.

## Диагностика

Основные повторяемые потери:

- scanner находит хороший payoff, но critic переносит его на соседний незавершённый фрагмент и отклоняет уже другой момент;
- региональный critic partition оставляет кандидаты нерассмотренными при свободной общей ёмкости;
- короткий setup/teaser занимает NMS-интервал полного эпизода;
- arc-audit правильно называет поздний payoff, но общий 25-секундный end-extension gate удаляет указатель до repair;
- finalizer trim мог вернуть старый конец после уже проверенного расширения;
- формально корректные клипы всё равно бывают скучными, без payoff или с чужой сценой после конца; текст и motion не заменяют проверку готового видео.

На 51 сохранённом development/holdout прогоне arc-audit отметил 37 проблемных концов. В 19 случаях предложенное исправление было отвергнуто именно как `outside_window`. На свежем s007 audit указал конец полного одобренного эпизода, но прежнее окно 25 секунд не позволяло пройти 54,92 секунды до payoff.

## Изменения ядра

- Неиспользованные scanner-кандидаты проверяются отдельной supplemental lane в пределах уже рассчитанного critic budget.
- Supplemental critic требует реально доставленный payoff и использует medium reasoning; затем кандидат проходит существующие evidence, snap, arc, boundary, finalizer и publishability стадии.
- Primary ответы и их порядок сохраняются. Единственное разрешённое вытеснение — полный, arc-clean эпизод, который полностью содержит ровно один primary teaser с `setup_no_payoff`. Широкий кандидат, пересекающий два primary, отклоняется.
- Финальные supplemental boundaries повторно проверяются на transcript holes. Неполный critic/finalizer/publishability review не добавляет клип и не превращает успешный primary результат в ошибку.
- Только supplemental lane может следовать arc-audit payoff до обычного `maxSec`. Scene rail, clean-end gate, transcript holes и предел 90 секунд остаются обязательными.
- Opening trim больше не отбрасывает уже проверенный конец: сохраняются final end node, end time и question state, если итоговая длительность остаётся допустимой.
- Добавлены customer-feedback и moment-recall метрики, top-k/publishable/boring поля с честным `unknown`, проверка завершённости model recordings, telemetry `added`/`replaced`, config fingerprint и выключаемый production-флаг `ANALYZE_SUPPLEMENTAL_RECALL_V1`.

## Результаты

| Набор | Метрика | Старая версия | Новая версия |
| --- | --- | ---: | ---: |
| Development, 31 unique source | найденные размеченные моменты | 19/32 | 21/32 |
| Development | пропущенные моменты | 13 | 11 |
| Development | клипы | 100 | 118 |
| Development | клиентские AS_IS | 0/2 | 1/2 |
| Development | повторённые NO интервалы | 2 | 2 |
| Holdout, 18 source | найденные моменты | 3/9 | 4/9 |
| Holdout | клипы | 69 | 78 |
| Новые 3 source | найденные моменты | 1/15 | 1/15 |
| Новые 3 source | клиентские AS_IS | 1/1 | 1/1 |
| Свежая парная проверка, 10 source | найденные моменты | 5/14 | 6/14 |
| Свежая парная проверка | пропущенные моменты | 9 | 8 |
| Свежая парная проверка | клиентские AS_IS | 0/2 | 1/2 |
| Свежая парная проверка | повторённые NO интервалы | 4 | 4 |

На свежей паре восстановлен точный клиентский AS_IS диапазон 0–64,58 секунды, и он оказался во втором результате. На другом source конец дошёл от обещания миллионного результата до `Access granted`; на s064 граница покрыла всю размеченную цепочку звонок→SMS и прошла production render (58,1 секунды, subtitles/reframe/cut без ошибки).

Глобальные P@3/P@5, boring rate и publishable clips/source остаются неизвестными: независимой оценки всех 196 итоговых клипов нет. Число outputs и LLM score не подменяют эти метрики. Установлено только, что подтверждённые клиентом/редакторской разметкой моменты добавились, primary клипы не потерялись, а известные NO интервалы не стали повторяться чаще.

Дополнительная стоимость на сохранённых прогонах: development 303→374 model calls, holdout 202→234. Это примерно 20% больше вызовов при неизменной верхней critic-ёмкости; технических supplemental failures в этих наборах не было.

## Регрессии и проверки

- Изменение общего finalizer prompt теряло primary клипы; оно ограничено supplemental lane.
- Прямое восстановление segment punctuation ухудшило покрытие 13/21→6/21 на восьми source; вариант отклонён.
- Append-only NMS блокировал полный эпизод при наличии teaser; добавлена узкая безопасная замена одного setup-only результата.
- Расширение всего primary end window не применялось. Длинный repair разрешён только supplemental lane и остаётся ограничен scene/maxSec/clean-end gates.
- 81 парное сравнение boundary fix: 80 результатов идентичны; единственное изменение добавило 2,5 секунды потерянного проверенного конца без изменения числа клипов/покрытия.
- Полная worker/shared suite: 3 641 passed, 54 failed, новых failure names против baseline нет. Остались существующие stale eval recordings, Docker-вызов из тестового контейнера и несвязанный analytics fixture. Targeted feature tests, worker typecheck и worker/shared build прошли.

## Production и rollback

13 сентября 2026 код выпущен в production commit `fa37b9a`, `ANALYZE_SUPPLEMENTAL_RECALL_V1=on`, analysis version `core-supplemental-recall-v1`. Перед сменой кода analyze queue была поставлена на паузу при `active=0`, `waiting=0`; пересоздан только `worker-analyze`, после smoke-check очередь возобновлена. Контейнер стартовал с прежним восстановленным API key, `running=true`, `restarting=false`, restart count 0.

Rollback сохранён веткой `rollback/core-live-2026-09-13-c34dc27`. Для отката: поставить analyze queue на паузу, выключить `ANALYZE_SUPPLEMENTAL_RECALL_V1`, вернуть live checkout к `c34dc27`, пересоздать только `worker-analyze`, проверить key/config и возобновить очередь.

## Следующие приоритеты

1. Вернуть клиентский AS_IS s037: visual/scanner nomination существует, но text-only critic смещает payoff; текущая версия всё ещё оставляет отклонённый клиентом прыжок.
2. Устранить cross-scene конец s058 и проверять реальную визуальную цельность после boundary repair.
3. Получить независимые оценки готовых клипов для publishable clips/source, boring rate и P@3/P@5; текущая разметка надёжно измеряет recall, но не полный precision.
4. Восстановить stale repository eval recordings и убрать 54 baseline test failures, не обновляя snapshots без реального replay.
5. Следить за latency/cost и `supplementalRecall.status`, `added`, `replaced`, arc gate/refusal telemetry на новых production jobs; флаг допускает мгновенное отключение без отката остального ядра.
